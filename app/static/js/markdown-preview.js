// static/js/markdown-preview.js
// The markdown renderer behind the "Preview Markdown" button, shared by the main page and the "open preview in a
// new tab" page so both always look the same. parse() returns raw HTML built from untrusted text; render() returns
// it sanitized (DOMPurify) and is what should be put on a page. If DOMPurify failed to load, render() shows the
// text literally instead of risking rendering unsanitized HTML.
(function () {
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function parse(text) {
        if (!text || !text.trim()) {
            return '<p style="color: var(--c-text-muted); font-style: italic;">Nothing to preview. Type some text to see the markdown rendered.</p>';
        }

        let html = text;

        // Code blocks with language (must be done first)
        html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
            return `<pre><code class="language-${lang || 'text'}">${escapeHtml(code.trim())}</code></pre>`;
        });

        // Inline code (avoid matching inside code blocks)
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Headers
        html = html.replace(/^###### (.*$)/gm, '<h6>$1</h6>');
        html = html.replace(/^##### (.*$)/gm, '<h5>$1</h5>');
        html = html.replace(/^#### (.*$)/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

        // Bold and Italic (order matters)
        html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

        // Strikethrough
        html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        // Blockquotes
        html = html.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');

        // Horizontal rules
        html = html.replace(/^---$/gm, '<hr>');
        html = html.replace(/^\*\*\*$/gm, '<hr>');

        // Unordered lists
        html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

        // Ordered lists
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

        // Wrap consecutive <li> in <ul>
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

        // Links [text](url)
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

        // Images ![alt](url)
        html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

        // Paragraphs (wrap text not in tags)
        html = html.split('\n\n').map(para => {
            if (para.trim() && !para.match(/^<(h[1-6]|ul|ol|li|pre|blockquote|hr|div)/)) {
                return `<p>${para.replace(/\n/g, '<br>')}</p>`;
            }
            return para;
        }).join('\n');

        return html;
    }

    function render(text) {
        const html = parse(text);
        if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(html);
        return escapeHtml(html);
    }

    window.SnailMarkdown = { parse, render };
})();
