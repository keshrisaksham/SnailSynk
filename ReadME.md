# 🐌 SnailSynk — Ultimate Edition

Oh good, another file-sharing app. Revolutionary. Except this one runs on **your** network, on **your** machine, with **your** files, and no cloud company gets to "improve your experience" with them. Built with Python, Flask and WebSockets. No internet required, which, given your Wi-Fi, may be a feature.

Yes, it's called SnailSynk. No, it is not slow. The snail is branding. Please stop making that joke, we've heard it.

***

## ✨ What it does

Short version: you put something in on one device, it shows up on the other one. Groundbreaking. Someone get the Nobel committee on the phone.

### 📋 Real-time sharing

* **Shared text buffer:** one text box, live on every device. For links, snippets, and that "send this to my phone" moment you have six times a day and still email to yourself.
* **Pinned messages:** pin text so it stays put. A sticky note, except it won't fall off your monitor and into the abyss behind your desk.
* **Preview in a new tab:** open the buffer as a full page with Markdown rendering. Same for images. Truly, the future.
* **Live everything:** uploads, deletes and edits appear on every device without a refresh, over WebSockets and HTTPS. Pressing F5 like a caveman is no longer required.

### 📂 Files and folders

* **Upload files or whole folders:** drag, drop, pick, or paste an image from your clipboard. Pick a folder and it arrives as a folder, a feature we are weirdly proud of.
* **Three views:** List, Details and Grid. Pick one. It remembers. Unlike you, with your passwords.
* **Sort and group:** by name, date or size, grouped by type, date, folders-first or files-first. Yes, you could have just named your files properly.
* **Right-click menu:** every file action in one place, only inside the download directory. We know. You tried it on the header. It doesn't work there.
* **Folders:** nested, with breadcrumbs, upload straight into any of them, move and rename. Finally, a place for the 14 files called `final_v2_REAL`.
* **Download as ZIP:** select a bunch, get one archive. Exactly once. We fixed the bug where you got it twice. You're welcome. (You didn't notice. Nobody ever notices.)
* **Locks:** password-protect files, lock folders, bulk lock, unlock or delete. Nosy housemates will be devastated.
* **Search:** instant filtering by name. Magic, if magic were `Ctrl+F`.

### 🛡️ Admin dashboard and notes

* **Live client monitoring:** see who is connected and what they did. Yes, you will find out exactly who is on your Wi-Fi at 3 a.m. No, we can't make that less awkward.
* **IP blocking:** block and unblock addresses. A velvet rope for your network, minus the bouncer with opinions.
* **Notes editor:** an admin-only notes space with a folder tree, drag and drop, search, a folder filter and multi-select (download, export, delete). The editor is Obsidian-style Markdown: type plain Markdown and it is shown formatted as you go (the marks only appear on the line you are editing). It has clickable checklists, `[[links]]` between notes (Ctrl+click), a reading view, a source view, word counts and PDF export. Notes are real `.md` files, and old rich-text notes are converted the first time you open them. Your secrets deserve better than a file called `notes_new (3).txt`.
* **Activity log:** every action is logged and rotated so the log doesn't eat your disk. We thought of that so you wouldn't have to.

### 🤖 BugByte AI chat

* Chat with Google Gemini for coding help. Yes, another AI. No, it won't take your job, it will just confidently suggest the wrong fix with great enthusiasm.
* Streaming replies with Markdown, syntax-highlighted code and KaTeX maths, because a wall of plain text is for amateurs.
* Admins can save, search and rename conversations, so you can prove later that it started it.
* Needs a free Gemini API key. Without one, the AI stays asleep and everything else works. Honestly, relatable.

### 🎨 Look and feel

* **Liquid-glass interface** with outline buttons and a soft grid that lights up around your mouse pointer. It does nothing useful. It looks great. Priorities. (Switched off if you ask your OS for reduced motion, because we're not monsters.)
* **Light and True Black dark modes.** The dark theme is pure black with thin edges and bright accents. For contrast, for OLED screens, and for the five people who actually read this far.
* **Accent colours:** red, blue, green, purple, orange or black. Pick the one that matches your personality. Every page follows, so there is nowhere to hide from your choice.
* **Responsive:** works on phones, with a bottom bar in the admin area. Yes, you will use the admin panel from the toilet. We know.

### 📱 Connectivity and security

* **QR codes** to open SnailSynk on a phone, or to join your Wi-Fi. Because typing an IP address on a phone is a hate crime.
* **HTTPS by default** with a self-signed certificate that **renews itself** when it's close to expiring or your IP changes. Set-and-forget security. Please don't forget, anyway.
* **Hardened where it counts:** path-traversal protection, an Argon2-hashed admin password, a rate-limited login, and atomic writes for data files (a corrupt file is set aside instead of crashing the app). Hackers hate this one weird trick: us doing the basics.
* **A readable terminal:** one tidy line per action, with a message when an upload or download starts and another when it finishes. No more wall of text that looks like the Matrix had a bad day.

> **Heads up, since nobody reads the fine print:** SnailSynk is built for a network you trust (home, office, a hotspot). Anyone on that network can upload, use the text buffer and chat with the AI without logging in. Admin features need the admin login. Do **not** expose it to the open internet and then write an angry issue. We will frame it.

***

## 💻 Technology

Because someone always asks.

| Layer | Technologies |
|-------|-------------|
| **Backend** | Python 3, Flask, Flask-SocketIO, gevent |
| **Frontend** | Vanilla JavaScript, HTML, CSS. No build step, no 800 MB of `node_modules`, no existential dread |
| **Real-time** | Socket.IO over WebSockets (wss) |
| **AI** | Google Gemini (`google-genai`) |
| **Security** | Argon2, self-signed TLS (`cryptography`) |
| **Other** | python-dotenv, rich, qrcode, pyperclip |

***

## 🚀 Getting started

Installation has been reduced to "run one file and answer three questions". If that's still too hard, we have bad news about the rest of your day.

### What you need

* **Python 3.8 or newer.** On Windows the installer offers to fetch it for you. We think of everything.
* **Git**, to clone the repository (or download the ZIP, we won't tell anyone).
* *(Optional)* a [Google Gemini API key](https://aistudio.google.com/apikey) for the AI chat. Free. Even you can afford it.

### Install

```bash
git clone https://github.com/keshrisaksham/SnailSynk-Ultimate.git
cd SnailSynk-Ultimate
```

Now run the installer for your system. It asks a few questions, installs the packages, makes a shortcut and starts the app. All the boring stuff, handled, so you can go back to ignoring your actual work.

| System | Run |
|--------|-----|
| **Windows** | double-click `Snail.bat`. Not right-click. Not "open with". Double-click |
| **Linux / macOS** | `./Snail.sh` (it asks for `sudo` once, only to install packages and create the `snailsynk` command. No, it won't run the server as root. We have standards) |
| **Android (Termux)** | `bash snail_termux.sh`. Yes, really. Yes, on your phone |

During setup you choose:

1. **An admin username and password.** The admin panel lives at `/admin`. Pick something better than `password123`. The snail will judge you. Press Enter at the password prompt for a random one, shown exactly once, so write it down. Or don't. Then enjoy `--reset-admin`.
2. **A port** (default `9000`). If it's taken, the installer will tell you. Politely. Barely.
3. **A Gemini API key**, or skip it and live a simpler, AI-free life.

Settings go in `.env`, and the admin password is stored scrambled in `instance/user.json`. Not in plain text. Not like it was in the old version. We don't talk about the old version.

### Every day after that

The hard part is over. From here on it's one click, which even you can manage.

* Windows: the **SnailSynk** desktop shortcut, or type `Snail` in a new terminal.
* Linux: the shortcut, or type `snailsynk`.
* Or run `python SnailSynk.py` yourself, if you enjoy doing things the hard way.

### Handy options

```
Snail.sh --reset-admin     forgot the admin password? of course you did
Snail.sh --setup           run the setup questions again, from the top
Snail.sh --help            list the options (revolutionary, we know)
```

On Windows use `Snail.bat` with the same options.

Prefer to configure by hand? Everything lives in `.env`. Go wild:

```
SNAILSYNK_PORT=9000
GEMINI_API_KEY='your_api_key_here'
```

***

## 🌐 How to use it

When it starts, the terminal shows two addresses. Read them. They are right there.

1. **On the same computer:** open `https://localhost:9000` (or your port). Yes, the `s` matters.
2. **From a phone, tablet or laptop:** same **Wi-Fi**, then the address from the terminal (for example `https://192.168.1.20:9000`), or scan the QR code from the *Connect a device* button. Different network? Then no. That's not how networks work.

Your browser will say **"Not secure"** and act very dramatic about it. That's because SnailSynk made its own certificate, at home, from scratch, like a tiny artisan, instead of paying a corporation to say "trust me". Click *Advanced*, then *Proceed*. Once per device. Then it shuts up.

The admin area is at `/admin`: live clients, IP blocking and the notes editor. It is where the snail keeps its secrets. Knock politely. Or don't, you have the password. Hopefully.

***

## 🔄 Updating

`upgrade.py` downloads the latest version from GitHub and replaces the app files, keeping your `.env`, `instance/` and install data:

```bash
python upgrade.py
```

It overwrites **everything else** in the folder. If you've been "improving" the code yourself, commit or back it up first. The snail will not be able to help you find it afterwards, and neither will we.

***

## ☕ Buy me a coffee

If SnailSynk saved you some time, consider supporting the project. Or don't. The snail will keep sharing your files either way, quietly judging. Every contribution does motivate new features, though, so consider it a bribe.

<p align="center">
  <a href="https://upi.link/payment?pa=kumarsaksham@yesg&pn=Saksham&cu=INR">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-UPI-orange?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white" alt="Buy Me a Coffee via UPI" />
  </a>
</p>

**UPI ID:** `kumarsaksham@yesg`

> Built with ❤️ (and a worrying amount of sarcasm) by [YawnByte](https://github.com/keshrisaksham)
