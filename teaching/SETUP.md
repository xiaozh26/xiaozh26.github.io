# /teaching — one-time setup

The teaching app is a static page (`/teaching/`) on the GitHub Pages site. Slides,
annotations, page order and the live "current slide" pointer are stored in
**Firebase** (Google): *Authentication* checks the password, *Cloud Firestore*
stores the data and pushes changes to every open device in real time. The free
Spark plan is enough — no credit card needed. Setup takes about ten minutes and
happens entirely in the browser.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com/> and sign in with a Google account.
2. **Add project** → name it e.g. `teaching` → you can switch Google Analytics off → **Create**.

## 2. Turn on password sign-in and create the teacher account

1. In the left menu: **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Email/Password** → Enable → Save.
3. **Users** tab → **Add user**:
   - Email: `teacher@xiaozhang.org` (must match `TEACHER_EMAIL` in `firebase-config.js`;
     it never has to receive mail)
   - Password: `200704`
   
   This password is the one the /teaching login page asks for. Change it here any time.
4. (Recommended) **Settings** tab → **User actions** → untick *Enable create (sign-up)* so
   nobody can create additional accounts.

## 3. Create the database and paste the security rules

1. **Build → Firestore Database → Create database** → choose a location near you
   (e.g. `us-west1`) → start in **production mode** → Create.
2. Open the **Rules** tab, replace everything with the contents of
   [`firestore.rules`](./firestore.rules) in this folder, and **Publish**.
   The rules allow access *only* to the signed-in teacher account.

## 4. Register a web app and copy its config

1. Project overview (gear icon) → **Project settings** → *Your apps* → **</>** (Web).
2. Nickname `teaching` → Register app (Firebase Hosting is not needed).
3. Copy the `firebaseConfig = { ... }` object it shows and paste the values into
   `teaching/firebase-config.js` in this repository.
4. Commit and push. GitHub Pages redeploys in a minute or two.

Those config values are *not* secrets — they only identify the project. Access is
enforced by the rules from step 3.

## 5. First run

Open <https://xiaozhang.org/teaching/> (or `/teaching/` on any device), enter the
password, and the CS 61A course appears. On the iPad, open the same URL in Safari and
use **Share → Add to Home Screen** for a chrome-free, app-like window.

## How it works / limits

- Slides are PDF files, stored in Firestore in 800 KB chunks (Firebase's file storage
  product now requires a paid plan, so the PDF is kept in the database instead).
  Export PowerPoint or Keynote decks with **File → Export → PDF** before uploading.
  Keep decks under ~60 MB; the free tier holds 1 GB in total.
- **Slides stay online only while you teach.** Upload the PDF before class; when the class
  is over press **Finish & remove** (on the course page, or in the viewer's export menu).
  It downloads the deck with all annotations baked in as `<title> - <label> (annotated).pdf`,
  then deletes the slides and annotations from Firebase. The block stays in the list as a
  record of the session. The course page shows a warning while any block still has slides
  online.
- **Toolbar**: on the laptop it starts collapsed to a single pen icon (so the projected view
  is clean); click the icon to open it, click again to close. On the iPad it starts open.
  Drag the icon to move the toolbar anywhere on either device; the position is remembered.
  Fullscreen (F) is only needed on the laptop that is being projected.
- **Palm rejection on iPad**: the lock icon in the toolbar (“Pencil only”) is on by default on
  the iPad. The slide then ignores fingers and your resting palm completely — only the Apple
  Pencil draws or erases, so nothing gets selected or pinch-zoomed by accident. Zoom with the
  toolbar buttons. Even with it off, touches are ignored while the pencil is on the screen and
  for 1.5 s afterwards.
- The login is remembered for 8 hours per device (`SESSION_HOURS`), then the password
  is required again. "Log out" ends it immediately.
- Everything auto-saves. If the network drops, the sync pill at the top turns red and
  says *Offline – reconnecting*; edits made meanwhile are queued locally and sent when
  the connection returns. If the iPad and laptop show different pages for more than a
  few seconds, the pill turns red and names the device that is out of sync.
- Files added: `teaching/index.html`, `style.css`, `app.js`, `firebase-config.js`,
  `61A.png`, `vendor/pdf*.js` (PDF renderer), and `robots.txt` at the site root, which
  asks search engines not to index `/teaching`. Nothing on the main site links to it.
