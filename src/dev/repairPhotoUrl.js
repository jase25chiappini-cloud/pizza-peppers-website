import { auth, db } from "../firebase";
import { doc, updateDoc } from "firebase/firestore";

export async function clearBadPhotoUrlIfNeeded() {
  const u = auth?.currentUser;
  if (!u) return;
  if (u.photoURL && typeof u.photoURL === 'string' && u.photoURL.includes("firebasestorage.app")) {
    try {
      await updateDoc(doc(db, "users", u.uid), { photoURL: null });
    } catch (e) {
      // no-op in dev
      console.warn("Failed to clear bad photoURL:", e);
    }
  }
}
