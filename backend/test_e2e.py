"""End-to-end test for the Flask Pulse Messenger backend."""
import queue
import time
import io as _io
import random
import string
import requests
import socketio

BASE = "http://localhost:5000"
rnd = lambda: "".join(random.choices(string.ascii_lowercase + string.digits, k=6))

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond:
        passed += 1; print("  [PASS]", name)
    else:
        failed += 1; print("  [FAIL]", name)

def api(path, method="GET", token=None, json=None, files=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    r = requests.request(method, BASE + path, headers=headers, json=json, files=files, timeout=15)
    data = None
    try: data = r.json()
    except Exception: pass
    return r.status_code, data

class Client:
    EVENTS = ["message:new", "friend:request", "friend:accepted", "presence", "typing", "message:read"]
    def __init__(self, token):
        self.sio = socketio.Client(reconnection=False)
        self.q = {ev: queue.Queue() for ev in self.EVENTS}
        for ev in self.EVENTS:
            self.sio.on(ev, lambda data, ev=ev: self.q[ev].put(data))
        self.sio.connect(BASE, auth={"token": token}, transports=["polling"], wait_timeout=10)
    def wait(self, ev, timeout=6):
        return self.q[ev].get(timeout=timeout)
    def call(self, ev, data, timeout=6):
        return self.sio.call(ev, data, timeout=timeout)
    def emit(self, ev, data):
        self.sio.emit(ev, data)
    def close(self):
        try: self.sio.disconnect()
        except Exception: pass

def main():
    print("\n=== Pulse Messenger (Flask) E2E test ===\n")
    a_name, b_name = "alice_" + rnd(), "bob_" + rnd()

    # 1. Register
    sa, alice = api("/api/register", "POST", json={"username": a_name, "displayName": "Alice Test", "password": "secret123"})
    sb, bob = api("/api/register", "POST", json={"username": b_name, "displayName": "Bob Test", "password": "secret123"})
    check("register two users", sa == 200 and sb == 200 and alice.get("token") and bob.get("token"))
    check("avatar color assigned", bool(alice["user"]["avatarColor"]))

    # 2. Login + 3. wrong password
    sl, _ = api("/api/login", "POST", json={"username": a_name, "password": "secret123"})
    check("login works", sl == 200)
    sw, _ = api("/api/login", "POST", json={"username": a_name, "password": "nope"})
    check("wrong password rejected", sw == 401)

    # 4. Duplicate username rejected
    sd, _ = api("/api/register", "POST", json={"username": a_name, "displayName": "Dup", "password": "secret123"})
    check("duplicate username rejected", sd == 409)

    at, bt = alice["token"], bob["token"]
    aid, bid = alice["user"]["id"], bob["user"]["id"]

    # 5. Search
    _, sr = api(f"/api/users/search?q=bob_", token=at)
    found = next((u for u in sr["users"] if u["id"] == bid), None)
    check("search finds user", found is not None)
    check("relationship 'none' initially", found and found["relationship"] == "none")

    # 6. Friend request + accept
    api("/api/friends/request", "POST", token=at, json={"userId": bid})
    _, reqs = api("/api/friends/requests", token=bt)
    incoming = next((r for r in reqs["incoming"] if r["id"] == aid), None)
    check("bob receives friend request", incoming is not None)
    api("/api/friends/respond", "POST", token=bt, json={"requestId": incoming["requestId"], "action": "accept"})
    _, af = api("/api/friends", token=at)
    bob_friend = next((f for f in af["friends"] if f["id"] == bid), None)
    check("alice & bob are friends", bob_friend is not None)
    check("conversation id present", bool(bob_friend and bob_friend.get("conversationId")))
    conv_id = bob_friend["conversationId"]

    # 7. Sockets
    ca, cb = Client(at), Client(bt)
    time.sleep(0.4)
    check("both sockets connected", ca.sio.connected and cb.sio.connected)

    # 8. presence via REST
    _, af2 = api("/api/friends", token=at)
    check("presence shows bob online", next(f for f in af2["friends"] if f["id"] == bid)["online"] is True)

    # 9. Realtime text message
    env = None
    ack = ca.call("message:send", {"toUserId": bid, "body": "Hello Bob! 👋"})
    check("send ack ok", ack and ack.get("ok") is True)
    env = cb.wait("message:new")
    check("bob receives realtime message", env["message"]["body"] == "Hello Bob! 👋")
    check("envelope has participants", str(aid) in env["participants"] and str(bid) in env["participants"])

    # 10. Typing
    ca.emit("typing", {"toUserId": bid, "isTyping": True})
    typ = cb.wait("typing")
    check("typing indicator delivered", typ["isTyping"] is True and typ["fromUserId"] == aid)

    # 11. Upload + media message
    files = {"file": ("photo.png", _io.BytesIO(b"hello-image-bytes"), "image/png")}
    su, up = api("/api/upload", "POST", token=at, files=files)
    check("upload returns url", su == 200 and up.get("url") and up.get("type") == "image")
    ca.call("message:send", {"toUserId": bid, "body": "", "attachment": up})
    menv = cb.wait("message:new")
    check("bob receives media message", menv["message"]["attachmentType"] == "image")

    # 12. uploaded file is served (local storage in dev)
    dl = requests.get(BASE + up["url"], timeout=10)
    check("uploaded file is served", dl.status_code == 200 and dl.content == b"hello-image-bytes")

    # 13. Read receipt
    cb.emit("message:read", {"conversationId": conv_id})
    rr = ca.wait("message:read")
    check("read receipt delivered to sender", rr["byUserId"] == bid)

    # 14. Conversation list + history
    _, ac = api("/api/conversations", token=at)
    conv = next((c for c in ac["conversations"] if c["id"] == conv_id), None)
    check("conversation list shows last message", bool(conv and conv["lastMessage"]))
    _, hist = api(f"/api/conversations/{conv_id}/messages", token=at)
    check("message history persisted (2 messages)", len(hist["messages"]) == 2)

    # 15. Non-friend cannot message
    _, carol = api("/api/register", "POST", json={"username": "carol_" + rnd(), "displayName": "Carol", "password": "secret123"})
    cc = Client(carol["token"])
    block = cc.call("message:send", {"toUserId": bid, "body": "spam"})
    check("non-friend message blocked", bool(block and block.get("error")))

    ca.close(); cb.close(); cc.close()
    print(f"\n=== Result: {passed} passed, {failed} failed ===\n")
    raise SystemExit(1 if failed else 0)

if __name__ == "__main__":
    main()
