# CollabEdit Server - Collaborative Real-Time Text Editor Backend

This directory contains the Express + Socket.io + Yjs WebSocket server backend for **CollabEdit**.

## 🛠️ Technology Stack

*   **Runtime**: Node.js
*   **Framework**: Express
*   **Real-time WebSocket & Presence**: Socket.io v4 with `@socket.io/redis-adapter`
*   **Collaboration Engine**: Yjs (CRDT) + `y-websocket`
*   **Database**: MongoDB (Mongoose)
*   **Caching & Adapter Store**: Redis
*   **Authentication**: JSON Web Tokens (JWT) with token rotation, cookie-parser, and Google OAuth 2.0 API integrations

## 📂 Folder Structure

*   `config/`:
    *   [db.js](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/config/db.js) - Establishes a connection to MongoDB using Mongoose.
*   `controllers/`:
    *   [authController.js](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/controllers/authController.js) - Implements JWT registration, login, logout, refresh token rotation, and Google OAuth callback exchanges.
*   `middleware/`:
    *   [authMiddleware.js](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/middleware/authMiddleware.js) - Restricts endpoints to authenticated requests by verifying the JWT access token in the headers.
*   `models/`:
    *   [Document.js](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/models/Document.js) - Schema definition for document documents containing collaborative Yjs states, titles, owner, and collaborator IDs.
    *   [User.js](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/models/User.js) - Schema definition for users, credentials, and refresh tokens.
*   `routes/`:
    *   [api.js](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/routes/api.js) - Maps authentication routes and contains CRUD endpoints for documents.
*   [index.js](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/index.js) - Main entrypoint initiating Express server, MongoDB connectivity, Socket.io connection, Redis adapter configuration, custom Yjs persistence mapping, and upgrade handlers for Yjs websocket traffic.

## ⚙️ Environment Configuration

Create a `.env` file in this directory based on the [.env.example](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/server/.env.example) template:

```env
PORT=5000
MONGO_URI=your_mongodb_uri
REDIS_URL=your_redis_url
JWT_SECRET=your_jwt_access_secret_key
JWT_REFRESH_SECRET=your_jwt_refresh_secret_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
CLIENT_URL=http://localhost:5173
NODE_ENV=development
```

## 🏃 Running Locally

To run the server independently, run the following from the `server/` subdirectory:

1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Start Dev Server**:
   ```bash
   npm run dev
   ```
   The server will run on [http://localhost:5000/](http://localhost:5000/).
