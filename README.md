# THE QUOTEBOOK

Black and white and very tuff. A members-only quotebook with logins, roles, categories, and requests.

- **Hosting:** GitHub Pages (free, basically never goes down)
- **Logins + database:** Firebase Auth + Firestore (free "Spark" plan, never pauses)
- **No build step:** plain HTML/CSS/JS. Edit a file, push, done.

## What's in it

| Page | What it does |
|---|---|
| Home | Random quote, stats, search, links to every section |
| The Book | Every quote. Search + sort (newest, oldest, by person, shuffle) |
| People | Browse by who said it |
| Added By | Browse by who entered it |
| Categories | Browse by category (quotes can have as many as you want) |
| + Add / + Request | Contributors and up add directly; enjoyers send requests |
| Requests | Owners/admins approve, edit & approve, or reject requests |
| Control Room | Owners let new sign-ups in, change roles, and download/restore backups |

### Roles

| Role | Can do |
|---|---|
| **owner** | Everything. Lock quotes so nobody else can delete them. Change anyone's role. Backups. |
| **admin** | Add. Edit/delete their own quotes and contributors' quotes. Can't touch owners' or other admins' work. Lock quotes (can't unlock an owner's lock). Review requests. |
| **contributor** | Add. Edit/delete only their own quotes (unless locked). |
| **enjoyer** | Read only. Send requests for additions. |

New sign-ups are **pending**: they can't see anything until an owner hits **Let in** on the Control Room page (they come in as enjoyers). **Turn away** blocks them; you can still let them in later. These rules are enforced by Firebase on the server (`firestore.rules`), so nobody can get around them by messing with the page.

---

## Setup (one time, ~10 minutes)

### 1. Make the Firebase project

1. Go to <https://console.firebase.google.com> → **Create a project** (call it whatever, you can turn Google Analytics off).
2. Left sidebar → **Build → Authentication** → **Get started**. Under *Sign-in method*, enable **Google** and **Email/Password**.
3. Left sidebar → **Build → Firestore Database** → **Create database** → pick a location near you → start in **production mode**.
4. In Firestore, open the **Rules** tab, delete what's there, paste in everything from [`firestore.rules`](firestore.rules), and hit **Publish**.
5. Click the gear icon (top left) → **Project settings** → scroll to *Your apps* → click the **`</>`** (Web) icon → give it a nickname → **Register app**. Leave "Firebase Hosting" unchecked.
6. It shows you a `firebaseConfig = { ... }` block. Copy those values into [`js/firebase-config.js`](js/firebase-config.js).

> The config values aren't secret. They end up public on GitHub, and that's fine, because the rules are what protect the data.

### 2. Put it on GitHub

```powershell
# from inside the "Quote Site" folder (already done for you: git init + first commit)
git remote add origin https://github.com/YOUR-USERNAME/quotebook.git
git branch -M main
git push -u origin main
```

Before running that, create the empty repo at <https://github.com/new>: name it `quotebook`, set it to **Public**, and **don't** add a README/.gitignore/license.

Then on GitHub: repo → **Settings → Pages** → *Source:* **Deploy from a branch** → Branch **main**, folder **/ (root)** → **Save**. After a minute or so it's live at:

```
https://YOUR-USERNAME.github.io/quotebook/
```

### 3. Let Firebase accept logins from that site

Firebase console → **Authentication → Settings → Authorized domains** → **Add domain** → `YOUR-USERNAME.github.io`

### 4. Make you and Maggie owners

1. You both open the site and sign in once (you'll be stuck "at the door" as pending).
2. Firebase console → **Firestore Database** → `users` collection → click your document → change the `role` field from `pending` to `owner`. Do the same for Maggie.
3. Refresh the site. From now on you can promote people from the **Control Room** page; no more console needed.

---

## Making changes later

```powershell
git add -A
git commit -m "describe what you changed"
git push
```

GitHub Pages redeploys automatically (takes ~1 minute).

If you change `firestore.rules`, also paste the new version into Firebase console → Firestore → Rules → **Publish**. GitHub doesn't do that part.

## Running it on your computer

ES modules don't load from `file://`, so run a tiny local server from this folder:

```powershell
npx serve .
# or
python -m http.server 8000
```

Then open the address it prints. `localhost` is already an authorized domain in Firebase.

## Backups

- **Quotes:** Control Room → **Download backup** saves every quote, member and request as a JSON file. Put it on the SSD. **Restore quotes from backup** puts them back.
- **The website itself:** it's all in this git repo. `git clone https://github.com/YOUR-USERNAME/quotebook.git` on the SSD, or just copy this folder.

## Free tier notes

Firebase Spark (free) gives 50,000 document reads and 20,000 writes per day. The site caches quotes in the browser, so a friend group won't come anywhere close. GitHub Pages is free for public repos. Total cost: $0.
