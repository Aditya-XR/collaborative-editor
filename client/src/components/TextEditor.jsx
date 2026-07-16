import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, FileText, Link, Check, Cloud, RefreshCw, AlertCircle } from 'lucide-react';
import { io } from 'socket.io-client';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { QuillBinding } from 'y-quill';
import QuillCursors from 'quill-cursors';

Quill.register('modules/cursors', QuillCursors);

// Styling override component to customize Quill appearance to be premium
const EditorStyleOverride = () => (
  <style>{`
    /* Quill custom overrides */
    .ql-toolbar.ql-snow {
      border: none !important;
      border-bottom: 1px solid #f1f5f9 !important; /* border-slate-100 */
      background-color: #ffffff;
      padding: 6px 24px !important;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      justify-content: center;
    }
    
    .ql-container.ql-snow {
      border: none !important;
      font-size: 16px;
      font-family: inherit;
    }
    
    .ql-editor {
      min-height: 900px;
      padding: 0 !important;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 16px;
      line-height: 1.7;
      color: #1e293b; /* slate-800 */
    }

    .ql-editor p {
      margin-bottom: 1.25rem;
    }

    .ql-editor:focus {
      outline: none;
    }

    /* Customize Quill toolbar button active states to match purple-600 */
    .ql-snow.ql-toolbar button:hover,
    .ql-snow .ql-toolbar button:hover,
    .ql-snow.ql-toolbar button:focus,
    .ql-snow .ql-toolbar button:focus,
    .ql-snow.ql-toolbar button.ql-active,
    .ql-snow .ql-toolbar button.ql-active,
    .ql-snow.ql-toolbar .ql-picker-label:hover,
    .ql-snow .ql-toolbar .ql-picker-label:hover,
    .ql-snow.ql-toolbar .ql-picker-label.ql-active,
    .ql-snow .ql-toolbar .ql-picker-label.ql-active,
    .ql-snow.ql-toolbar .ql-picker-item:hover,
    .ql-snow .ql-toolbar .ql-picker-item:hover,
    .ql-snow.ql-toolbar .ql-picker-item.ql-selected,
    .ql-snow .ql-toolbar .ql-picker-item.ql-selected {
      color: #7c3aed !important;
    }
    
    .ql-snow.ql-toolbar button:hover .ql-stroke,
    .ql-snow .ql-toolbar button:hover .ql-stroke,
    .ql-snow.ql-toolbar button:focus .ql-stroke,
    .ql-snow .ql-toolbar button:focus .ql-stroke,
    .ql-snow.ql-toolbar button.ql-active .ql-stroke,
    .ql-snow .ql-toolbar button.ql-active .ql-stroke,
    .ql-snow.ql-toolbar .ql-picker-label:hover .ql-stroke,
    .ql-snow .ql-toolbar .ql-picker-label:hover .ql-stroke,
    .ql-snow.ql-toolbar .ql-picker-label.ql-active .ql-stroke,
    .ql-snow .ql-toolbar .ql-picker-label.ql-active .ql-stroke,
    .ql-snow.ql-toolbar .ql-picker-item:hover .ql-stroke,
    .ql-snow .ql-toolbar .ql-picker-item:hover .ql-stroke,
    .ql-snow.ql-toolbar .ql-picker-item.ql-selected .ql-stroke,
    .ql-snow .ql-toolbar .ql-picker-item.ql-selected .ql-stroke {
      stroke: #7c3aed !important;
    }

    .ql-snow.ql-toolbar button:hover .ql-fill,
    .ql-snow .ql-toolbar button:hover .ql-fill,
    .ql-snow.ql-toolbar button:focus .ql-fill,
    .ql-snow .ql-toolbar button:focus .ql-fill,
    .ql-snow.ql-toolbar button.ql-active .ql-fill,
    .ql-snow .ql-toolbar button.ql-active .ql-fill,
    .ql-snow.ql-toolbar .ql-picker-label:hover .ql-fill,
    .ql-snow .ql-toolbar .ql-picker-label:hover .ql-fill,
    .ql-snow.ql-toolbar .ql-picker-label.ql-active .ql-fill,
    .ql-snow .ql-toolbar .ql-picker-label.ql-active .ql-fill,
    .ql-snow.ql-toolbar .ql-picker-item:hover .ql-fill,
    .ql-snow .ql-toolbar .ql-picker-item:hover .ql-fill,
    .ql-snow.ql-toolbar .ql-picker-item.ql-selected .ql-fill,
    .ql-snow .ql-toolbar .ql-picker-item.ql-selected .ql-fill {
      fill: #7c3aed !important;
    }
  `}</style>
);

const TOOLBAR_OPTIONS = [
  [{ header: [1, 2, 3, false] }],
  [{ font: [] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ color: [] }, { background: [] }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  [{ align: [] }],
  ['blockquote', 'code-block'],
  ['link', 'image'],
  ['clean']
];

const TextEditor = () => {
  const { id: documentId } = useParams();
  const navigate = useNavigate();

  const { user, token, authFetch } = useAuth();
  const [socket, setSocket] = useState(null);
  const [quill, setQuill] = useState(null);
  const [title, setTitle] = useState('Loading...');
  const [saveStatus, setSaveStatus] = useState('connecting'); // 'connecting' | 'saving' | 'saved' | 'error'
  const [copied, setCopied] = useState(false);

  // Presence and Cursor Overlay States
  const [activeUsers, setActiveUsers] = useState([]);
  const [cursorCoords, setCursorCoords] = useState({});

  // 1. Establish Socket Connection for Presence and Metadata Sync
  useEffect(() => {
    if (!token) return;
    
    const backendUrl = import.meta.env.VITE_API_URL 
      ? import.meta.env.VITE_API_URL.replace('/api', '') 
      : 'http://localhost:5000';
    const s = io(backendUrl, {
      auth: { token }
    });
    setSocket(s);

    s.on('connect_error', () => {
      setSaveStatus('error');
    });

    return () => {
      s.disconnect();
    };
  }, [token]);

  // 2. Initialize Quill Editor
  const wrapperRef = useCallback((wrapper) => {
    if (wrapper == null) return;

    wrapper.innerHTML = '';
    const editor = document.createElement('div');
    wrapper.append(editor);

    const q = new Quill(editor, {
      theme: 'snow',
      modules: {
        cursors: true,
        toolbar: TOOLBAR_OPTIONS
      }
    });

    q.disable();
    q.setText('Loading document...');

    // Move the generated toolbar to our custom pinned parent container
    const toolbar = wrapper.querySelector('.ql-toolbar');
    const toolbarParent = document.getElementById('toolbar-parent');
    if (toolbar && toolbarParent) {
      toolbarParent.innerHTML = '';
      toolbarParent.appendChild(toolbar);
    }

    setQuill(q);
  }, []);

  // 3. Initialize Yjs, y-websocket, and Quill Binding
  useEffect(() => {
    if (quill == null || !documentId || !token) return;

    const doc = new Y.Doc();
    
    let wsUrl = import.meta.env.VITE_WS_URL;
    if (!wsUrl || wsUrl === 'undefined' || wsUrl === 'null') {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
      wsUrl = apiUrl.replace('/api', '');
    }
    // Clean up URL, enforce wss://, and remove trailing slashes
    wsUrl = wsUrl.replace('/api', '').replace('http://', 'ws://').replace('https://', 'wss://').replace(/\/+$/, '');

    console.log('[Yjs] Attempting WebSocket connection to:', `${wsUrl}/yjs`);
    console.log('[Yjs] Document ID:', documentId);

    let provider;
    try {
      provider = new WebsocketProvider(
        `${wsUrl}/yjs`,
        documentId,
        doc,
        { params: { token } }
      );
      console.log('[Yjs] WebsocketProvider initialized');
    } catch (err) {
      console.error("[Yjs] Failed to initialize WebsocketProvider:", err);
      return;
    }

    const ytext = doc.getText('quill');
    const binding = new QuillBinding(ytext, quill, provider.awareness);

    // Update status indicators using the Yjs websocket provider connection state
    provider.on('status', ({ status }) => {
      if (status === 'connected') {
        setSaveStatus('saved');
      } else if (status === 'connecting') {
        setSaveStatus('connecting');
      } else {
        setSaveStatus('error');
      }
    });

    provider.on('sync', (isSynced) => {
      if (isSynced) {
        quill.enable();
        // Remove the loading text and focus the editor
        if (quill.getText().trim() === 'Loading document...') {
          quill.setText('');
        }
      }
    });

    return () => {
      binding.destroy();
      provider.destroy();
      doc.destroy();
    };
  }, [quill, documentId, token]);

  // 4. Handle Socket.io Presence and Meta Synchronization
  useEffect(() => {
    if (socket == null || !documentId) return;

    // Join presence room
    socket.emit('join-document', {
      documentId
    });

    // Load initial document metadata (title) via API
    const loadMetadata = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
        const res = await authFetch(`${apiUrl}/documents/${documentId}`);
        if (res.ok) {
          const doc = await res.json();
          if (doc && doc.title) {
            setTitle(doc.title);
          } else {
            setTitle('Untitled Document');
          }
        } else {
          setTitle('Untitled Document');
        }
      } catch (err) {
        console.error('Error fetching metadata:', err);
        setTitle('Untitled Document');
      }
    };
    loadMetadata();

    // Listen to live presence list updates
    socket.on('presence-update', (users) => {
      setActiveUsers(users);
    });

    // Listen to title modifications
    socket.on('receive-title-changes', (newTitle) => {
      setTitle(newTitle);
    });

    return () => {
      socket.off('presence-update');
      socket.off('receive-title-changes');
    };
  }, [socket, documentId, user]);

  // 5. Monitor Caret Selection and emit to Socket.io for Cursor Tracking
  useEffect(() => {
    if (socket == null || quill == null || !documentId) return;

    const handleSelectionChange = (range) => {
      if (range) {
        socket.emit('cursor-move', {
          documentId,
          range: { index: range.index, length: range.length }
        });
      }
    };

    quill.on('selection-change', handleSelectionChange);

    return () => {
      quill.off('selection-change', handleSelectionChange);
    };
  }, [socket, quill, documentId]);

  // 6. Recalculate and update cursor screen coordinates
  const updateCursorPositions = useCallback(() => {
    if (!quill) return;
    const newCoords = {};
    activeUsers.forEach(user => {
      if (user.socketId === socket?.id || !user.cursor) return;
      try {
        const bounds = quill.getBounds(user.cursor.index);
        if (bounds) {
          newCoords[user.socketId] = {
            left: bounds.left,
            top: bounds.top,
            height: bounds.height
          };
        }
      } catch (e) {
        // Index out of range
      }
    });
    setCursorCoords(newCoords);
  }, [quill, activeUsers, socket]);

  // Trigger coordinate recalcs on presence updates, text changes or selection changes
  useEffect(() => {
    updateCursorPositions();
  }, [activeUsers, updateCursorPositions]);

  useEffect(() => {
    if (!quill) return;
    const handler = () => updateCursorPositions();
    quill.on('text-change', handler);
    quill.on('selection-change', handler);
    return () => {
      quill.off('text-change', handler);
      quill.off('selection-change', handler);
    };
  }, [quill, updateCursorPositions]);

  // 7. Handle Document Title Updates from Local
  const handleTitleChange = (e) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    setSaveStatus('saving');
    
    if (socket) {
      socket.emit('send-title-changes', newTitle);
      socket.emit('save-title', { documentId, title: newTitle });
      setTimeout(() => setSaveStatus('saved'), 500);
    }
  };

  // 8. Copy Share Room Link to Clipboard
  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <EditorStyleOverride />

      {/* Sticky Header Layout */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm flex flex-col">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center space-x-4 flex-1 min-w-0">
            <button
              onClick={() => navigate('/')}
              className="text-slate-500 hover:text-slate-700 hover:bg-slate-100 p-2 rounded-lg transition-colors cursor-pointer"
              title="Back to Dashboard"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center space-x-3 flex-1 min-w-0">
              <div className="bg-purple-100 text-purple-700 p-2 rounded-lg shrink-0">
                <FileText className="w-5 h-5" />
              </div>
              <div className="flex flex-col flex-1 min-w-0">
                <input
                  type="text"
                  value={title}
                  onChange={handleTitleChange}
                  disabled={saveStatus === 'connecting'}
                  className="font-semibold text-slate-800 text-base md:text-lg focus:outline-none border-b border-transparent hover:border-slate-300 focus:border-purple-600 transition-colors py-0.5 truncate max-w-sm"
                  placeholder="Untitled Document"
                />
                
                {/* Cloud Saving Status Bar */}
                <div className="flex items-center space-x-1.5 text-xs">
                  {saveStatus === 'connecting' && (
                    <span className="flex items-center text-amber-600 font-medium">
                      <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" />
                      Connecting server...
                    </span>
                  )}
                  {saveStatus === 'saving' && (
                    <span className="flex items-center text-blue-600 font-medium">
                      <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" />
                      Saving changes...
                    </span>
                  )}
                  {saveStatus === 'saved' && (
                    <span className="flex items-center text-emerald-600 font-medium">
                      <Cloud className="w-3.5 h-3.5 mr-1" />
                      Saved to cloud
                    </span>
                  )}
                  {saveStatus === 'error' && (
                    <span className="flex items-center text-rose-600 font-medium">
                      <AlertCircle className="w-3.5 h-3.5 mr-1" />
                      Offline / Server Unreachable
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right Action Section */}
          <div className="flex items-center space-x-4 ml-4 shrink-0">
            {/* Active Users Avatars */}
            <div className="hidden sm:flex items-center -space-x-2 mr-2">
              {activeUsers.map((u, idx) => {
                const safeName = u.username || 'Anonymous';
                const initials = safeName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                const isMe = u.socketId === socket?.id;
                return u.avatar ? (
                  <img
                    key={u.socketId || idx}
                    src={u.avatar}
                    alt={u.username}
                    className="w-8 h-8 rounded-full border-2 border-white shadow-sm cursor-help transition-all duration-200 hover:-translate-y-0.5 object-cover"
                    title={`${u.username} ${isMe ? '(You)' : ''}`}
                  />
                ) : (
                  <div 
                    key={u.socketId || idx}
                    className="w-8 h-8 rounded-full text-white flex items-center justify-center font-semibold text-xs border-2 border-white shadow-sm cursor-help transition-all duration-200 hover:-translate-y-0.5"
                    style={{ backgroundColor: u.color }}
                    title={`${u.username} ${isMe ? '(You)' : ''}`}
                  >
                    {initials}
                  </div>
                );
              })}
              {activeUsers.length > 5 && (
                <div 
                  className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center font-semibold text-[10px] border-2 border-white shadow-sm"
                  title={`${activeUsers.length - 5} other active editors`}
                >
                  +{activeUsers.length - 5}
                </div>
              )}
            </div>

            {/* Copy Link Button */}
            <button
              onClick={handleCopyLink}
              disabled={saveStatus === 'connecting'}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-all cursor-pointer shadow-sm ${
                copied
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-white hover:bg-slate-50 text-slate-700 border border-slate-300'
              }`}
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-emerald-600" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Link className="w-4 h-4 text-slate-500" />
                  <span>Copy Share Link</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Pinned Toolbar Container */}
        <div id="toolbar-parent" className="bg-slate-50 border-t border-slate-200 min-h-[42px] flex items-center justify-center" />
      </header>

      {/* Document Canvas */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8 flex justify-center">
        <div className="w-full max-w-4xl bg-white min-h-[1056px] shadow-lg rounded-sm border border-slate-200 p-12 md:p-20 mb-16 relative">
          {/* A4 Sheet Guide Line (Optional top margin/header indicator) */}
          <div className="absolute top-8 left-0 right-0 px-12 md:px-20 flex justify-between text-[10px] text-slate-300 pointer-events-none select-none">
            <span>Page 1</span>
            <span>CollabEdit Workspace</span>
          </div>
          
          {/* Main Quill editor mount point with custom caret overlay */}
          <div className="relative mt-4">
            <div ref={wrapperRef} />
            
            {/* Custom Carets Overlay */}
            {activeUsers.map(u => {
              const coords = cursorCoords[u.socketId];
              if (!coords) return null;
              return (
                <div
                  key={u.socketId}
                  className="absolute pointer-events-none z-10 transition-all duration-75"
                  style={{
                    left: `${coords.left}px`,
                    top: `${coords.top}px`,
                    height: `${coords.height}px`,
                  }}
                >
                  {/* Caret Line */}
                  <div 
                    className="w-[2px] h-full" 
                    style={{ backgroundColor: u.color }}
                  />
                  {/* Label */}
                  <div 
                    className="absolute bottom-full left-0 px-1.5 py-0.5 rounded text-[10px] font-bold text-white whitespace-nowrap shadow-sm animate-fade-in flex items-center space-x-1"
                    style={{ backgroundColor: u.color }}
                  >
                    {u.avatar && (
                      <img src={u.avatar} alt="" className="w-3.5 h-3.5 rounded-full object-cover shrink-0" />
                    )}
                    <span>{u.username}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
};

export default TextEditor;
