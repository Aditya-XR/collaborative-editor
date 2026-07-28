# CollabEdit - Real-Time Collaborative Editor with Gemini AI

CollabEdit is a modern, full-stack, collaborative rich-text document workspace built on the **MERN** stack (MongoDB, Express, React, Node.js). It combines **Yjs (CRDT)** for conflict-free real-time text synchronization, **Socket.io & Redis** for live user presence and cursor tracking, and **Google Gemini 2.5 Flash AI** for context-aware document assistant capabilities.

---

## 🚀 Key Features

### 🤖 1. Context-Aware Gemini AI Assistant
* **Embedded AI Panel**: Dedicated AI assistant drawer in the editor equipped with query input and output preview.
* **Smart `@Document` Context Referencing**: Type `@` to trigger real-time document search autocomplete and reference other documents in your workspace (e.g. `@"Project Spec"`).
* **Deep Yjs Binary Context Extraction**: The backend automatically parses binary Yjs state updates of referenced documents from MongoDB and feeds their text content directly to **Gemini 2.5 Flash** (`@google/genai`).
* **Direct Content Insertion**: Preview AI output and insert generated content directly at your active cursor position or selection in the Quill editor with one click.

### ✍️ 2. Real-Time Collaborative Editing (Yjs CRDT)
* **Conflict-Free Mutations**: Powered by Yjs (CRDT algorithm), allowing multiple users to edit the same document simultaneously without edit collisions or lost updates.
* **WebSocket Synchronization**: Fast, low-latency document sync via `y-websocket` and `y-quill`.
* **Database Persistence**: Yjs document states are automatically serialized and persisted as binary updates in MongoDB.

### 👥 3. Live Presence & Multi-User Cursor Tracking
* **Live Avatars & Indicators**: Displays user avatars (Google profile picture or color-coded initials) for all active editors currently in the document room.
* **Custom Remote Carets**: Shows live cursor positions and selection highlights of peer editors with custom name tags.
* **Horizontal Scaling with Redis**: Scaled using `@socket.io/redis-adapter` and Upstash Redis hash maps, with stale presence auto-cleanup (2-minute TTL).

### 🔒 4. Authentication & Security
* **JWT Access & Refresh Tokens**: Secure authentication flow with short-lived JWT access tokens and HTTP-only refresh cookies featuring Token Rotation.
* **Google OAuth 2.0 Integration**: 1-click Google Sign-In and profile synchronization.
* **Protected WebSockets**: Token verification on Socket.io connection handshakes and `/yjs` HTTP Upgrade requests before upgrading WebSocket connections.

### 📊 5. Document Management & Workspace
* **Dashboard Workspace**: Comprehensive document manager featuring live title search and multi-criteria sorting (Last Edited, Title A-Z, Title Z-A).
* **Owner & Collaborator Access Control**: Automatically assigns document ownership and adds users as collaborators upon accessing shared room links. Deletion is restricted to document owners.
* **Real-Time Title Sync**: Instant header title updates across all connected peers.
* **1-Click Room Link Sharing**: Copy shareable room link directly to clipboard.
* **A4 Sheet UI**: Premium distraction-free document layout configured as an A4 sheet with a sticky header and pinned Quill toolbar powered by Tailwind CSS v4.

---

## 🛠️ Technology Stack

| Domain | Technologies Used |
| :--- | :--- |
| **Frontend** | React 19, Vite, Tailwind CSS v4, Lucide Icons, Quill 2, Quill Cursors, Yjs, y-websocket, y-quill, Socket.io Client |
| **Backend** | Node.js, Express, Yjs, y-websocket, Socket.io, Mongoose, JWT, bcryptjs, `@google/genai` (Gemini 2.5 Flash) |
| **Database & Caching** | MongoDB Atlas, Upstash Redis (Socket.io Redis Adapter & presence store) |
| **Tooling & Linter** | Concurrently, Nodemon, Oxlint |

---

## ⚙️ Project Structure

```text
collaborative-editor/
├── client/                      # React Frontend Application (Vite)
│   ├── public/                  # Static assets
│   ├── src/
│   │   ├── assets/              # App images and logos
│   │   ├── components/
│   │   │   ├── AuthPage.jsx       # Login & Registration workflows with Google OAuth
│   │   │   ├── AuthSuccess.jsx    # OAuth redirect & token handler
│   │   │   ├── Dashboard.jsx      # Document workspace, search, sorting & manager
│   │   │   ├── ProtectedRoute.jsx # Route guarding for authenticated users
│   │   │   └── TextEditor.jsx     # Main workspace (Quill + Yjs + Socket.io + Gemini AI)
│   │   ├── context/
│   │   │   └── AuthContext.jsx    # Global Auth state & token refresh manager
│   │   ├── App.jsx                # Application routes
│   │   ├── App.css                # Global style overrides
│   │   ├── index.css              # Tailwind CSS imports & theme setup
│   │   └── main.jsx               # React entry point
│   ├── .oxlintrc.json           # Oxlint code quality configuration
│   ├── package.json             # Frontend dependencies & scripts
│   ├── vercel.json              # Vercel deployment configuration
│   └── vite.config.js           # Vite build configuration
│
├── server/                      # Express Backend Server & WebSockets
│   ├── config/
│   │   └── db.js              # MongoDB Atlas connection setup
│   ├── controllers/
│   │   └── authController.js  # Auth logic (Register, Login, Google OAuth, Refresh)
│   ├── middleware/
│   │   └── authMiddleware.js  # JWT validation middleware
│   ├── models/
│   │   ├── Document.js        # Mongoose Document Schema (title, owner, collaborators, binary data)
│   │   └── User.js            # Mongoose User Schema (auth credentials, avatar, color)
│   ├── routes/
│   │   ├── ai.js              # Gemini AI (/api/ai/ask) & Document Search endpoints
│   │   └── api.js             # Auth & Document CRUD routes
│   ├── index.js               # Express server, Socket.io (Redis Adapter), Yjs WebSockets & persistence
│   ├── test-redis.js          # Redis connectivity test utility
│   ├── .env.example           # Environment template
│   └── package.json             # Backend dependencies & scripts
│
├── package.json                 # Root script runner (concurrently)
└── README.md                    # Project documentation
```

---

## 🏃 Getting Started

### 1. Prerequisites
* **Node.js**: v18.0.0 or higher
* **npm**: v9.0.0 or higher
* **MongoDB**: MongoDB Atlas URI or local MongoDB instance
* **Redis**: Redis URL (e.g., Upstash Redis or local Redis server)
* **Google Gemini API Key**: Obtainable from [Google AI Studio](https://aistudio.google.com/)

### 2. Installation
Clone the repository and install all dependencies for the root, frontend, and backend packages:
```bash
git clone https://github.com/Aditya-XR/collaborative-editor.git
cd collaborative-editor
npm run install-all
```

### 3. Environment Configuration
Create a `.env` file inside the `server/` directory:

```env
PORT=5000
MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/collabedit
REDIS_URL=redis://default:<password>@<host>:<port>
JWT_SECRET=your_jwt_access_secret_key
JWT_REFRESH_SECRET=your_jwt_refresh_secret_key
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GEMINI_API_KEY=your_gemini_api_key
CLIENT_URL=http://localhost:5173
NODE_ENV=development
```

*(Optional)* Create a `.env` file in the `client/` directory for local environment variables:
```env
VITE_API_URL=http://localhost:5000/api
VITE_WS_URL=ws://localhost:5000
```

### 4. Running Locally
Start both backend and frontend development servers concurrently:
```bash
npm run dev
```

* **Frontend App**: Accessible at `http://localhost:5173/`
* **Backend REST API**: Running at `http://localhost:5000/api`
* **Yjs WebSocket Endpoint**: `ws://localhost:5000/yjs`

---

## 📦 Production Deployment

The project is configured for cloud deployment across **Vercel** and **Railway**:

* **Frontend Client (Vercel)**: [https://collaborative-editor-sable.vercel.app](https://collaborative-editor-sable.vercel.app)
* **Backend Server (Railway)**: [https://collaborative-editor-production-ed0f.up.railway.app](https://collaborative-editor-production-ed0f.up.railway.app)

### Production Environment Variables

#### Backend (Railway Environment):
```env
PORT=5000
MONGO_URI=your_mongodb_atlas_connection_string
REDIS_URL=redis://your_redis_production_url:port
JWT_SECRET=your_production_jwt_access_secret
JWT_REFRESH_SECRET=your_production_jwt_refresh_secret
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GEMINI_API_KEY=your_gemini_api_key
CLIENT_URL=https://collaborative-editor-sable.vercel.app
NODE_ENV=production
```

#### Frontend (Vercel Environment):
```env
VITE_API_URL=https://collaborative-editor-production-ed0f.up.railway.app/api
VITE_WS_URL=wss://collaborative-editor-production-ed0f.up.railway.app
```

---

## 📜 License

This project is open-source and available under the [MIT License](LICENSE).
