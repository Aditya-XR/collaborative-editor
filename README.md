# CollabEdit - Collaborative Real-Time Text Editor

CollabEdit is a modern, premium, collaborative rich-text editor workspace similar to Google Docs. It is built on the MERN stack (MongoDB, Express, React, Node.js) and powered by **Socket.io** for real-time text synchronization and **Quill** for rich text formatting.

## 🚀 Key Features

*   **Real-Time Collaborative Editing**: Multiple users can connect to the same document room using a unique URL and collaborate simultaneously.
*   **Granular Text Sync**: Utilizes Quill Deltas to sync precise text mutations immediately across clients via Socket.io without disrupting cursor positions.
*   **Real-Time Title Synchronization**: Users can rename documents directly from the header, syncing the new title across all active peers instantly.
*   **Automatic Cloud Saving**: Autosaves document contents and titles to MongoDB at a debounced 2-second interval.
*   **Premium A4 Sheet UI**: A realistic, distraction-free document layout configured as an A4 sheet of paper with a sticky toolbar and headers.
*   **Collaborator Avatars**: Displays visual indicators of active editors currently connected to the workspace.
*   **Quick Share Link**: Click to copy the shareable room link directly to the clipboard with visual confirmation.

---

## 🛠️ Technology Stack

*   **Frontend**: React (Vite), Tailwind CSS v4, Lucide Icons, Quill Rich-Text Editor, Socket.io-client.
*   **Backend**: Node.js, Express, Socket.io, Mongoose.
*   **Database**: MongoDB Atlas.

---

## ⚙️ Project Structure

```
├── client/              # React frontend application
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard.jsx   # Landing page with document manager
│   │   │   └── TextEditor.jsx  # Main collaborative workspace
│   │   ├── App.jsx            # Routing configurations
│   │   └── main.jsx           # App entry point
│   └── package.json
│
├── server/              # Express backend server
│   ├── config/
│   │   └── db.js              # Mongoose MongoDB connection
│   ├── models/
│   │   └── Document.js        # Mongoose Document Schema (data, title)
│   ├── routes/
│   │   └── api.js             # API health check router
│   ├── index.js               # Express + Socket.io Server logic
│   └── package.json
│
└── package.json         # Root configuration for concurrent run scripts
```

---

## 🏃 Getting Started

### 1. Prerequisites
Make sure you have **Node.js** (v16.0.0 or higher) and **npm** installed on your machine.

### 2. Install Dependencies
Run the installation command from the root directory to install all packages for the root, frontend, and backend folders:
```bash
npm run install-all
```

### 3. Environment Setup
The backend requires a MongoDB connection string. Create or inspect the `.env` file in the `/server` directory:
```env
MONGO_URI=your_mongodb_connection_string
PORT=5000
```
*(A default pre-configured cluster URI is already provided in the repository for testing)*.

### 4. Run Development Server
Start both the backend server and frontend development server concurrently:
```bash
npm run dev
```
Once started:
*   **Frontend Client**: Running at [http://localhost:5173/](http://localhost:5173/) (or next available port).
*   **Backend Server**: Running at [http://localhost:5000/](http://localhost:5000/).

---

## 📦 Production Build

To compile a production build of the React frontend, run:
```bash
npm run build --prefix client
```
The optimized bundle will be generated in `client/dist`.
