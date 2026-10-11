# routes/routes_ai_chat.py
import os
import re
import json
import uuid
import base64
import logging
import time
from pathlib import Path
from flask import Blueprint, request, jsonify, session, render_template, Response, stream_with_context
from google import genai
from google.genai import types
from backbone.rate_limiter import RateLimiter
from backbone.storage import atomic_write_json

ai_chat_bp = Blueprint('ai_chat', __name__, template_folder='../templates')

# Action logger will be initialized by the main app
action_logger = None
_conversations_dir = None
_gemini_client = None

GEMINI_MODEL = 'gemini-2.5-flash'

# The chat endpoints are open to everyone on the network but spend the owner's API quota.
ai_limiter = RateLimiter(max_attempts=20, window=60, lockout=60)   # 20 requests / minute / IP
MAX_MESSAGE_CHARS = 20_000
MAX_HISTORY_ENTRIES = 60
MAX_IMAGES = 4
MAX_IMAGE_B64_CHARS = 8 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}
CONV_ID_RE = re.compile(r'^[0-9a-f]{8}$')

def init_ai_chat_routes(al, instance_path=None):
    """Initialize the blueprint with managers from the main app."""
    global action_logger, _conversations_dir
    action_logger = al
    if instance_path:
        _conversations_dir = os.path.join(instance_path, 'conversations')
        os.makedirs(_conversations_dir, exist_ok=True)

def _get_conversations_dir():
    """Get the conversations directory, creating it if needed."""
    if _conversations_dir and os.path.isdir(_conversations_dir):
        return _conversations_dir
    return None

def get_gemini_client():
    """Get or initialize the Gemini client. Called at runtime to ensure .env is loaded."""
    global _gemini_client
    GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
    if not GEMINI_API_KEY:
        return None
    
    try:
        if _gemini_client is None:
            _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        return _gemini_client
    except Exception as e:
        logging.error(f"Failed to initialize Gemini client: {e}")
        return None

def _build_history(history_list):
    """Convert a list of {role, parts} dicts to google.genai types.Content objects."""
    contents = []
    for entry in history_list:
        role = entry.get('role', 'user')
        parts_data = entry.get('parts', [])
        parts = []
        for p in parts_data:
            if isinstance(p, dict) and 'text' in p:
                parts.append(types.Part.from_text(text=p['text']))
            elif isinstance(p, str):
                parts.append(types.Part.from_text(text=p))
        if parts:
            contents.append(types.Content(role=role, parts=parts))
    return contents


def _friendly_error(e):
    """Map upstream errors to a safe message - never echo raw exception text to the browser."""
    upper = str(e).upper()
    if "API_KEY" in upper or "API KEY" in upper:
        return "Invalid API key. Please check your GEMINI_API_KEY configuration."
    if "QUOTA" in upper or "RESOURCE_EXHAUSTED" in upper:
        return "API quota exceeded. Please try again later."
    if "SAFETY" in upper:
        return "Message blocked by safety filters. Please rephrase your message."
    return "The AI service returned an error. Please try again."

def _throttle():
    wait = ai_limiter.hit(request.remote_addr)
    if wait:
        return jsonify(success=False, error=f"Too many requests. Try again in {wait} seconds."), 429
    return None

def _validate_history(history):
    """Return a sanitized history list or None if malformed/too large."""
    if not isinstance(history, list) or len(history) > MAX_HISTORY_ENTRIES:
        return None
    clean = []
    for entry in history:
        if not isinstance(entry, dict) or entry.get('role', 'user') not in ('user', 'model'):
            return None
        parts = entry.get('parts', [])
        if not isinstance(parts, list):
            return None
        total = sum(len(p.get('text', '')) if isinstance(p, dict) and isinstance(p.get('text', ''), str) else (len(p) if isinstance(p, str) else 0) for p in parts)
        if total > MAX_MESSAGE_CHARS * 2:
            return None
        clean.append(entry)
    return clean

def _get_conv_path(conv_dir, conv_id):
    """Path of a conversation file, or None if the id is not one we generated."""
    if not CONV_ID_RE.match(conv_id or ''):
        return None
    return os.path.join(conv_dir, f"{conv_id}.json")


# ─── Page Route ───────────────────────────────────────────────────────────────

@ai_chat_bp.route('/chat')
def chat_page():
    """Render the BugByte chat page."""
    is_admin = session.get('admin_logged_in', False)
    return render_template('chat.html', is_admin=is_admin)


# ─── Legacy API (non-streaming, kept for backwards compat on index page) ──────

@ai_chat_bp.route('/api/ai-chat', methods=['POST'])
def ai_chat():
    """Handle AI chat messages using Google Gemini."""
    client = get_gemini_client()
    
    if not client:
        return jsonify(
            success=False, 
            error="AI chat is not configured. Please add GEMINI_API_KEY to your environment variables."
        ), 503
    
    limited = _throttle()
    if limited: return limited

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('message'), str):
        return jsonify(success=False, error="Invalid request. Message is required."), 400
    
    user_message = data['message'].strip()
    if not user_message:
        return jsonify(success=False, error="Message cannot be empty."), 400
    if len(user_message) > MAX_MESSAGE_CHARS:
        return jsonify(success=False, error="Message is too long."), 413
    
    # Get conversation history if provided
    history = _validate_history(data.get('history', []))
    if history is None:
        return jsonify(success=False, error="Invalid conversation history."), 400
    
    try:
        # Build history as types.Content objects
        chat_history = _build_history(history)
        
        # Start a chat session with history
        chat = client.chats.create(model=GEMINI_MODEL, history=chat_history)
        
        # Send the message and get response
        response = chat.send_message(user_message)
        
        # Log the interaction
        if action_logger:
            action_logger.log(
                request.remote_addr, 
                'AI_CHAT', 
                {
                    'message_length': len(user_message),
                    'response_length': len(response.text)
                }
            )
        
        return jsonify(
            success=True,
            response=response.text,
            message="AI response generated successfully."
        )
    
    except Exception as e:
        logging.error(f"Error in AI chat: {e}")
        return jsonify(success=False, error=_friendly_error(e)), 500


# ─── Streaming API ────────────────────────────────────────────────────────────

@ai_chat_bp.route('/api/ai-chat/stream', methods=['POST'])
def ai_chat_stream():
    """Stream AI chat responses using Server-Sent Events (SSE)."""
    client = get_gemini_client()
    
    if not client:
        return jsonify(
            success=False,
            error="AI chat is not configured. Please add GEMINI_API_KEY to your environment variables."
        ), 503
    
    limited = _throttle()
    if limited: return limited

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get('message'), str):
        return jsonify(success=False, error="Invalid request. Message is required."), 400
    
    user_message = data['message'].strip()
    images = data.get('images') or []  # [{ "base64": "...", "mimeType": "image/png" }, ...]
    if not user_message and not images:
        return jsonify(success=False, error="Message cannot be empty."), 400
    if len(user_message) > MAX_MESSAGE_CHARS:
        return jsonify(success=False, error="Message is too long."), 413

    history = _validate_history(data.get('history', []))
    if history is None:
        return jsonify(success=False, error="Invalid conversation history."), 400
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        return jsonify(success=False, error=f"At most {MAX_IMAGES} images are allowed."), 400
    decoded_images = []
    for img in images:
        if not isinstance(img, dict) or img.get('mimeType', 'image/png') not in ALLOWED_IMAGE_TYPES \
                or not isinstance(img.get('base64', ''), str) or len(img.get('base64', '')) > MAX_IMAGE_B64_CHARS:
            return jsonify(success=False, error="Unsupported or oversized image."), 400
        try:
            decoded_images.append((base64.b64decode(img.get('base64', ''), validate=True), img.get('mimeType', 'image/png')))
        except ValueError:
            return jsonify(success=False, error="Invalid image data."), 400
    
    def generate():
        try:
            # Build history as types.Content objects
            chat_history = _build_history(history)
            
            chat = client.chats.create(model=GEMINI_MODEL, history=chat_history)
            
            # Build multimodal parts
            parts = []
            if user_message:
                parts.append(types.Part.from_text(text=user_message))
            for img_bytes, img_mime in decoded_images:
                parts.append(types.Part.from_bytes(data=img_bytes, mime_type=img_mime))
            
            # If no text was provided with images, add a default prompt
            if not user_message and decoded_images:
                parts.insert(0, types.Part.from_text(text="Describe this image."))
            
            # Use send_message_stream for streaming
            full_response = []
            for chunk in chat.send_message_stream(parts):
                if chunk.text:
                    full_response.append(chunk.text)
                    # Send each chunk as an SSE event
                    yield f"data: {json.dumps({'type': 'chunk', 'content': chunk.text})}\n\n"
            
            # Send completion event
            full_text = ''.join(full_response)
            yield f"data: {json.dumps({'type': 'done', 'content': full_text})}\n\n"
            
            # Log the interaction
            if action_logger:
                action_logger.log(
                    request.remote_addr,
                    'AI_CHAT_STREAM',
                    {
                        'message_length': len(user_message),
                        'response_length': len(full_text)
                    }
                )
                
        except Exception as e:
            logging.error(f"Error in streaming AI chat: {e}")
            yield f"data: {json.dumps({'type': 'error', 'content': _friendly_error(e)})}\n\n"
    
    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        }
    )


# ─── Conversations CRUD ──────────────────────────────────────────────────────

@ai_chat_bp.route('/api/conversations', methods=['GET'])
def list_conversations():
    """List all saved conversations (admin only)."""
    if not session.get('admin_logged_in', False):
        return jsonify(error="Admin access required"), 403
    conv_dir = _get_conversations_dir()
    if not conv_dir:
        return jsonify(conversations=[])
    
    conversations = []
    for filename in os.listdir(conv_dir):
        if filename.endswith('.json'):
            filepath = os.path.join(conv_dir, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                conversations.append({
                    'id': data.get('id', filename.replace('.json', '')),
                    'title': data.get('title', 'Untitled'),
                    'created_at': data.get('created_at', 0),
                    'updated_at': data.get('updated_at', 0),
                    'message_count': len(data.get('messages', []))
                })
            except (json.JSONDecodeError, IOError):
                continue
    
    # Sort by most recently updated
    conversations.sort(key=lambda x: x['updated_at'], reverse=True)
    return jsonify(conversations=conversations)


@ai_chat_bp.route('/api/conversations', methods=['POST'])
def create_conversation():
    """Create a new conversation (admin only)."""
    if not session.get('admin_logged_in', False):
        return jsonify(error="Admin access required"), 403
    conv_dir = _get_conversations_dir()
    if not conv_dir:
        return jsonify(error="Storage not available"), 500
    
    data = request.get_json(silent=True) or {}
    conv_id = str(uuid.uuid4())[:8]
    now = time.time()
    
    conversation = {
        'id': conv_id,
        'title': str(data.get('title', 'New Chat'))[:200],
        'created_at': now,
        'updated_at': now,
        'messages': []
    }
    
    filepath = _get_conv_path(conv_dir, conv_id)
    if not filepath:
        return jsonify(error="Conversation not found"), 404
    atomic_write_json(filepath, conversation)
    
    return jsonify(conversation), 201


@ai_chat_bp.route('/api/conversations/<conv_id>', methods=['GET'])
def get_conversation(conv_id):
    """Get a specific conversation with its messages (admin only)."""
    if not session.get('admin_logged_in', False):
        return jsonify(error="Admin access required"), 403
    conv_dir = _get_conversations_dir()
    if not conv_dir:
        return jsonify(error="Storage not available"), 500
    
    filepath = _get_conv_path(conv_dir, conv_id)
    if not filepath:
        return jsonify(error="Conversation not found"), 404
    if not os.path.exists(filepath):
        return jsonify(error="Conversation not found"), 404
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    except (json.JSONDecodeError, IOError) as e:
        logging.error(f"Failed to read conversation: {e}")
        return jsonify(error="Failed to read conversation."), 500


@ai_chat_bp.route('/api/conversations/<conv_id>', methods=['PUT'])
def update_conversation(conv_id):
    """Update conversation metadata (admin only)."""
    if not session.get('admin_logged_in', False):
        return jsonify(error="Admin access required"), 403
    conv_dir = _get_conversations_dir()
    if not conv_dir:
        return jsonify(error="Storage not available"), 500
    
    filepath = _get_conv_path(conv_dir, conv_id)
    if not filepath:
        return jsonify(error="Conversation not found"), 404
    if not os.path.exists(filepath):
        return jsonify(error="Conversation not found"), 404
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        update_data = (request.get_json(silent=True) or {})
        if 'title' in update_data:
            data['title'] = str(update_data['title'])[:200]
        data['updated_at'] = time.time()
        
        atomic_write_json(filepath, data)
        
        return jsonify(data)
    except (json.JSONDecodeError, IOError) as e:
        logging.error(f"Failed to update conversation: {e}")
        return jsonify(error="Failed to update conversation."), 500


@ai_chat_bp.route('/api/conversations/<conv_id>', methods=['DELETE'])
def delete_conversation(conv_id):
    """Delete a conversation (admin only)."""
    if not session.get('admin_logged_in', False):
        return jsonify(error="Admin access required"), 403
    conv_dir = _get_conversations_dir()
    if not conv_dir:
        return jsonify(error="Storage not available"), 500
    
    filepath = _get_conv_path(conv_dir, conv_id)
    if not filepath:
        return jsonify(error="Conversation not found"), 404
    if not os.path.exists(filepath):
        return jsonify(error="Conversation not found"), 404
    
    try:
        os.remove(filepath)
        return jsonify(success=True, message="Conversation deleted")
    except IOError as e:
        logging.error(f"Failed to delete conversation: {e}")
        return jsonify(error="Failed to delete conversation."), 500


@ai_chat_bp.route('/api/conversations/<conv_id>/messages', methods=['PUT'])
def save_messages(conv_id):
    """Save/update messages for a conversation (admin only)."""
    if not session.get('admin_logged_in', False):
        return jsonify(error="Admin access required"), 403
    conv_dir = _get_conversations_dir()
    if not conv_dir:
        return jsonify(error="Storage not available"), 500
    
    filepath = _get_conv_path(conv_dir, conv_id)
    if not filepath:
        return jsonify(error="Conversation not found"), 404
    if not os.path.exists(filepath):
        return jsonify(error="Conversation not found"), 404
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        update_data = (request.get_json(silent=True) or {})
        if 'messages' in update_data:
            data['messages'] = update_data['messages']
        if 'title' in update_data:
            data['title'] = str(update_data['title'])[:200]
        data['updated_at'] = time.time()
        
        atomic_write_json(filepath, data)
        
        return jsonify(success=True)
    except (json.JSONDecodeError, IOError) as e:
        logging.error(f"Failed to save messages: {e}")
        return jsonify(error="Failed to save messages."), 500
