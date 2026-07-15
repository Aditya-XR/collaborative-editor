# CollabEdit Client - Collaborative Real-Time Text Editor Frontend

This directory contains the React + Vite frontend application for **CollabEdit**. It is styled with Tailwind CSS v4, uses Quill as the rich-text editor interface, and synchronizes documents via Yjs over WebSockets.

## 🛠️ Technology Stack

*   **Framework**: React 19 (Vite 8)
*   **Styling**: Tailwind CSS v4
*   **Rich Text Editor**: Quill v2 + y-quill
*   **Real-time Collaboration**: Yjs (CRDT) + y-websocket
*   **Icons**: Lucide React
*   **Routing**: React Router v7

## 📂 Folder Structure

*   `src/components/`:
    *   [AuthPage.jsx](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/client/src/components/AuthPage.jsx) - Handles JWT credentials registration/login and Google OAuth workflows.
    *   [AuthSuccess.jsx](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/client/src/components/AuthSuccess.jsx) - Redirect landing component after a successful Google OAuth login.
    *   [Dashboard.jsx](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/client/src/components/Dashboard.jsx) - The user dashboard containing the documents list, user info, search, sorting, and new document creation options.
    *   [ProtectedRoute.jsx](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/client/src/components/ProtectedRoute.jsx) - Route guard to redirect unauthorized users to `/login`.
    *   [TextEditor.jsx](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/client/src/components/TextEditor.jsx) - The main editor workspace displaying the Quill editor, toolbar, active collaborators cursors, live document title editing, and A4 paper styling.
*   `src/context/`:
    *   [AuthContext.jsx](file:///c:/Users/Aditya%20Kumar/OneDrive/Desktop/Collabrative_editer/client/src/context/AuthContext.jsx) - React context for managing user authentication state, token refresh, and login/logout functions.
*   `src/App.jsx` - Configures React Router routes.

## 🏃 Running Locally

To run the client independently, run the following from the `client/` subdirectory:

1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Start Dev Server**:
   ```bash
   npm run dev
   ```
   The client will run on [http://localhost:5173/](http://localhost:5173/).

## 📦 Production Build

To build the project for production, run:
```bash
npm run build
```
The compiled output will be generated in `client/dist`.
