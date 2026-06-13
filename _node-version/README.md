# 💬 Pulse Messenger

A professional, real-time messenger — like Messenger — built with **Node.js**, **Socket.io**, and **SQLite**.
Chat in real time, add friends, and share photos, videos, and files.

---

## ✨ Features

- 🔐 **Secure accounts** — register / login (passwords hashed with bcrypt, sessions via JWT)
- 💬 **Real-time chat** — messages appear instantly using WebSockets (Socket.io)
- 👥 **Add friends** — search people, send/accept/decline friend requests
- 📷 **Media sharing** — send photos, 🎥 videos, and 📎 files (up to 50 MB)
- 🟢 **Presence** — see who is online and "last active" time
- ✍️ **Typing indicator** — see when your friend is typing
- ✓ **Read receipts** — see when your message was "Seen"
- 🔔 **Notifications** — in-app toasts for new messages & friend requests
- 📱 **Responsive** — works on desktop and mobile browsers

---

## 🚀 How to run

### Easiest way (Windows)
Double-click **`start.bat`**. It installs everything the first time, then starts the server.

### Or from a terminal
```bash
npm install      # only the first time
npm start
```

Then open your browser to:

```
http://localhost:3000
```

---

## 👫 How to chat with a friend

1. Open `http://localhost:3000` and **Sign up** (create an account).
2. To test with a second person, open another browser (or another device on the
   same Wi-Fi using `http://YOUR-PC-IP:3000`) and sign up a second account.
3. In the **search bar**, type your friend's username and click **Add**.
4. The other person opens the **Requests** tab and clicks **Accept**.
5. You're now friends — open the chat and start messaging in real time! 🎉

> Same network tip: find your PC's IP with `ipconfig` (look for *IPv4 Address*),
> then friends on the same Wi-Fi can reach you at `http://THAT-IP:3000`.

---

## 🗂️ Project structure

```
server.js        # Backend: REST API + Socket.io real-time engine
db.js            # Database layer (built-in node:sqlite)
public/
  index.html     # App markup
  styles.css     # Professional Messenger-style UI
  app.js         # Client logic (auth, chat, friends, uploads)
data/            # SQLite database + secret key (auto-created)
uploads/         # Uploaded photos / videos / files (auto-created)
```

---

## 🔧 Notes

- No external accounts or API keys needed — everything runs on your machine.
- Data is stored locally in `data/messenger.db`.
- To start completely fresh, stop the server and delete the `data/` folder.
- Change the port with an environment variable, e.g. `set PORT=4000 && npm start`.

Built with ❤️ using Node.js, Express, Socket.io, and SQLite.
