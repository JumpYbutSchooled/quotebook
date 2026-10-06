// Everything app.js uses from Firebase, bundled into js/vendor/firebase.js by `npm run build:firebase`.
// We self-host this instead of loading it from gstatic.com, because Safari's tracking protection
// can restrict scripts served from Google's domains (which broke logins on iPhones).
export { initializeApp } from "firebase/app";
export {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile
} from "firebase/auth";
export {
  initializeFirestore,
  getFirestore,
  memoryLocalCache,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  onSnapshot,
  collection,
  query,
  where,
  writeBatch,
  serverTimestamp,
  Timestamp
} from "firebase/firestore";
