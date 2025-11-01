import { storage, auth, db, FB_READY } from "../firebase";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { doc, updateDoc } from "firebase/firestore";

export async function uploadAvatarAndSaveProfile(file) {
  if (!FB_READY || !auth || !storage || !db) {
    throw new Error("Uploads unavailable (Firebase not configured).");
  }
  const user = auth?.currentUser;
  if (!user) throw new Error("Not signed in");

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const key = `users/${user.uid}/avatar_${Date.now()}.${ext}`;

  const r = ref(storage, key);
  const snap = await uploadBytes(r, file, { contentType: file.type || 'image/jpeg' });
  const url = await getDownloadURL(snap.ref);

  await updateDoc(doc(db, "users", user.uid), { photoURL: url });
  return url;
}
