# Trackument

California K-12 HR Documentation System

## Deploy to Railway (step-by-step)

### What you need
- A GitHub account (free) — github.com
- A Railway account (free) — railway.app
- Your Anthropic API key

---

### Step 1 — Put your files on GitHub

1. Go to github.com and sign in
2. Click the **+** button (top right) → **New repository**
3. Name it `trackument`, set it to **Private**, click **Create repository**
4. On the next page, click **uploading an existing file**
5. Drag ALL the files from this folder into the upload area:
   - `server.js`
   - `package.json`
   - `.gitignore`
   - The `public/` folder (drag the whole folder)
6. Click **Commit changes**

---

### Step 2 — Deploy on Railway

1. Go to railway.app and sign in with your GitHub account
2. Click **New Project**
3. Click **Deploy from GitHub repo**
4. Select your `trackument` repository
5. Railway will detect it's a Node.js app and start deploying automatically
6. Wait about 60 seconds for the first deploy to finish

---

### Step 3 — Add your environment variables

In Railway, click on your project, then click the **Variables** tab, then add:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (starts with `sk-ant-...`) |
| `BETA_PASSWORD` | Choose a password for your beta testers |

Click **Deploy** after adding variables.

---

### Step 4 — Get your URL

1. Click the **Settings** tab in Railway
2. Under **Networking**, click **Generate Domain**
3. Railway gives you a URL like `trackument-production.up.railway.app`
4. Share that URL and your beta password with your testers

---

### Updating the app later

When you make changes to the HTML or server:
1. Go to your GitHub repository
2. Click on the file you want to update → click the pencil (edit) icon
3. Make your changes → click **Commit changes**
4. Railway automatically redeploys within about 60 seconds

---

## Local development (optional)

If you want to run it on your own computer for testing:

1. Install Node.js from nodejs.org
2. Open Terminal, navigate to this folder
3. Run: `npm install`
4. Create a `.env` file with:
   ```
   ANTHROPIC_API_KEY=your-key-here
   BETA_PASSWORD=your-password-here
   ```
5. Run: `node server.js`
6. Open: http://localhost:3000
