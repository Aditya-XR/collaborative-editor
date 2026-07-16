# CollabEdit - Collaborative Real-Time Text Editor

CollabEdit is a modern, premium, collaborative rich-text editor workspace similar to Google Docs. It is built on the MERN stack (MongoDB, Express, React, Node.js) and powered by **Yjs** for robust, conflict-free document synchronization and **Socket.io / Redis** for real-time presence.

## 🚀 Key Features

*   **Robust Collaborative Editing (Yjs)**: Multiple users can connect to the same document room using a unique URL and collaborate simultaneously. Built on Yjs (CRDT) for conflict-free, precise text mutations.
*   **Secure User Authentication & OAuth**: Complete JWT-based authentication system using HTTP-only cookies, Token Rotation, and bcrypt for secure registration/login, alongside integrated **Google OAuth 2.0 (Google Sign-In)**.
*   **Live Presence & Avatars**: Utilizes Socket.io (scaled via Redis Adapter) to display visual indicators and live cursor positions of active editors currently connected to the workspace.
*   **Real-Time Title Synchronization**: Users can rename documents directly from the header, syncing the new title across all active peers instantly.
*   **Automatic Cloud Saving**: Autosaves document contents and titles to MongoDB Atlas seamlessly.
*   **Premium A4 Sheet UI**: A realistic, distraction-free document layout configured as an A4 sheet of paper with a sticky toolbar and headers, powered by Tailwind CSS v4.
*   **Quick Share Link**: Click to copy the shareable room link directly to the clipboard with visual confirmation.

---

## 🛠️ Technology Stack

*   **Frontend**: React (Vite), Tailwind CSS v4, Lucide Icons, Quill Rich-Text Editor, Yjs & y-quill, Socket.io-client.
*   **Backend**: Node.js, Express, Yjs (y-websocket), Socket.io, Mongoose, JWT, bcryptjs.
*   **Database & Caching**: MongoDB Atlas, Redis (for Socket.io scaling & caching).

---

## ⚙️ Project Structure

```text
├── client/              # React frontend application
│   ├── src/
│   │   ├── components/
│   │   │   ├── AuthPage.jsx       # Login & Registration workflows
│   │   │   ├── AuthSuccess.jsx    # OAuth/Auth success handler
│   │   │   ├── Dashboard.jsx      # Landing page with document manager
│   │   │   ├── ProtectedRoute.jsx # Route guarding for authenticated users
│   │   │   └── TextEditor.jsx     # Main collaborative workspace (Quill + Yjs)
│   │   ├── context/
│   │   │   └── AuthContext.jsx    # Global authentication state provider
│   │   ├── App.jsx                # Routing configurations
│   │   └── main.jsx               # App entry point
│   └── package.json
│
├── server/              # Express backend server
│   ├── config/
│   │   └── db.js              # Mongoose MongoDB connection
│   ├── controllers/         # Request handling logic
│   ├── middleware/
│   │   └── authMiddleware.js  # JWT validation middleware
│   ├── models/
│   │   ├── Document.js        # Mongoose Document Schema (data, title, owner)
│   │   └── User.js            # Mongoose User Schema (auth details)
│   ├── routes/
│   │   └── api.js             # API router for documents & auth endpoints
│   ├── index.js               # Express + Socket.io + Yjs WebSocket Server
│   └── package.json
│
└── package.json         # Root configuration for concurrent run scripts
```

---

## 🏃 Getting Started

### 1. Prerequisites
Make sure you have **Node.js** (v16.0.0 or higher), **npm**, and a running instance of **Redis** installed on your machine.

### 2. Install Dependencies
Run the installation command from the root directory to install all packages for the root, frontend, and backend folders:
```bash
npm run install-all
```

### 3. Environment Setup
The backend requires MongoDB, Redis, JWT, and Google OAuth configurations. Create or inspect the `.env` file in the `/server` directory:
```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_jwt_access_secret_key
JWT_REFRESH_SECRET=your_jwt_refresh_secret_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
CLIENT_URL=http://localhost:5173
NODE_ENV=development
```

### 4. Run Development Server
Start both the backend server and frontend development server concurrently:
```bash
npm run dev
```
Once started:
*   **Frontend Client**: Running at [http://localhost:5173/](http://localhost:5173/)
*   **Backend API**: Running at [http://localhost:5000/](http://localhost:5000/)
*   **Yjs Websocket**: Running at `ws://localhost:5000/yjs`

---

## 📦 Production Deployment

The application is deployed across two platforms:

*   **Frontend Client (Vercel)**: [https://collaborative-editor-sable.vercel.app](https://collaborative-editor-sable.vercel.app)
*   **Backend Server (Railway)**: [https://collaborative-editor-production-ed0f.up.railway.app](https://collaborative-editor-production-ed0f.up.railway.app)

### Production Environment Variables

**Backend (Railway Variables)**:
```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
REDIS_URL=redis://your_redis_production_url:port
JWT_SECRET=your_jwt_access_secret_key
JWT_REFRESH_SECRET=your_jwt_refresh_secret_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
CLIENT_URL=https://collaborative-editor-sable.vercel.app
NODE_ENV=production
```

**Frontend (Vercel Variables)**:
```env
VITE_API_URL=https://collaborative-editor-production-ed0f.up.railway.app/api
VITE_WS_URL=wss://collaborative-editor-production-ed0f.up.railway.app
```

To compile a production build of the React frontend locally, run:
```bash
npm run build --prefix client
```
The optimized bundle will be generated in `client/dist`.
