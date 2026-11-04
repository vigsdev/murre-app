# Murre: tester guide

Thank you for trying Murre. It is a Mac app that keeps your After Effects projects organised, and it can now bring a Premiere Pro project and its footage along. This is an early build, so please read the safety notes first.

## Is it safe?

- Your original `.aep` and `.prproj` files are **never changed**. Everything goes into a **new** project folder that Murre makes.
- Collecting copies footage, so the new folder can be as big as the footage the project uses. The dialog shows the size before you agree. Check you have the disk space.
- Even so, this is a first release of a tool that saves and rewrites project files. **Please use a project you have a backup of.**

## Install

1. Open the `.dmg` and drag **Murre** into **Applications**.
2. The app is not signed yet, so macOS will say it cannot check it. Open Terminal and run this once:

   ```
   xattr -dr com.apple.quarantine /Applications/Murre.app
   ```

   (Or right-click the app and choose **Open**, then **Open** again.)
3. Open Murre and enter your name when it asks.
4. Go to **Settings → Companion** and press **Install**. This puts a small panel into After Effects. **Quit and reopen After Effects** afterwards. The panel is under **Window → Extensions → Murre**.

## What to try

1. In After Effects, open a real project of yours (a big one is the most useful).
2. In Murre, press **From After Effects**.
3. If you have Premiere Pro projects beside the `.aep`, in a folder next to it, or one folder above, they are listed. Tick the ones you want collected.
4. Choose where the new project folder goes and press **Choose folder and add…**. Wait for the message at the end.
5. Open the new project. Open the **Premiere Pro projects** card, open the collected `.prproj`, and check that every clip is online.

Also welcome: **Render…** on the Renders tab, and the **Scan & organize** button in the After Effects panel.

## What to tell me

Please answer these:

1. Did the collected Premiere project open with every clip online? If not, how many were offline?
2. The message at the end of the add: how many files were copied, and how many "not found"?
3. How big was the project, and how long did the add take?
4. Anything odd. I am especially interested in: image sequences, Dynamic Link (After Effects comps in Premiere, or Premiere projects in After Effects), and files with the same name from different folders.
5. A screenshot of anything that looks wrong.

## If something goes wrong

Open **Settings → About → Report a problem → Copy report** and paste the result into your message. It holds the app version, your macOS version and the recent activity, with file paths and names removed. Nothing is sent anywhere unless you paste it.

## Known limits

- **Image sequences** in a Premiere project are only partly copied (the first frame).
- **After Effects comps linked into Premiere** keep pointing at the original `.aep`.
- Projects made on **Windows** will show their footage as "not found".
- The Premiere collect is only in the app's **From After Effects** button, not in the panel's Add project.
- No automatic updates yet: I will send you a new build when something is fixed.
