// Firebase configuration for the /teaching app.
// Fill this in following teaching/SETUP.md. The values are safe to publish:
// access is enforced by Firebase Authentication + the Firestore security rules,
// not by keeping these strings secret.

export const firebaseConfig = {
  apiKey: "AIzaSyBUruP1XIOPYdes3_Mh-tEbcmUzMeWVKEw",
  authDomain: "teaching-e01fb.firebaseapp.com",
  projectId: "teaching-e01fb",
  databaseURL: "https://teaching-e01fb-default-rtdb.firebaseio.com/",   // fill in after creating Realtime Database (SETUP.md step 3b) — enables live ink
  storageBucket: "teaching-e01fb.firebasestorage.app",
  messagingSenderId: "998870626407",
  appId: "1:998870626407:web:763fde1e60ea040b1ba4c2"
};

// The single account that may sign in. Create it in Firebase Console →
// Authentication → Users with the password you want (e.g. 200704).
export const TEACHER_EMAIL = "teacher@xiaozhang.org";

// How long a login stays valid on a device before the password is asked again.
export const SESSION_HOURS = 8;
