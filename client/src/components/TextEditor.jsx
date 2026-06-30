import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText, Link, Check, Cloud, RefreshCw, AlertCircle } from 'lucide-react';
import { io } from 'socket.io-client';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';

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

  const [socket, setSocket] = useState(null);
  const [quill, setQuill] = useState(null);
  const [title, setTitle] = useState('Loading...');
  const [saveStatus, setSaveStatus] = useState('connecting'); // 'connecting' | 'saving' | 'saved' | 'error'
  const [copied, setCopied] = useState(false);

  // 1. Establish Socket Connection
  useEffect(() => {
    const s = io('http://localhost:5000');
    setSocket(s);

    s.on('connect_error', () => {
      setSaveStatus('error');
    });

    return () => {
      s.disconnect();
    };
  }, []);

  // 2. Initialize Quill editor
  const wrapperRef = useCallback((wrapper) => {
    if (wrapper == null) return;

    wrapper.innerHTML = '';
    const editor = document.createElement('div');
    wrapper.append(editor);

    const q = new Quill(editor, {
      theme: 'snow',
      modules: {
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

  // 3. Connect Socket with Quill
  useEffect(() => {
    if (socket == null || quill == null) return;

    socket.emit('get-document', documentId);

    socket.once('load-document', ({ data, title: loadedTitle }) => {
      quill.setContents(data);
      quill.enable();
      setTitle(loadedTitle || 'Untitled Document');
      setSaveStatus('saved');
    });
  }, [socket, quill, documentId]);

  // 4. Handle text changes: Emit to server
  useEffect(() => {
    if (socket == null || quill == null) return;

    const handler = (delta, oldDelta, source) => {
      if (source !== 'user') return;
      socket.emit('send-changes', delta);
      setSaveStatus('saving');
    };

    quill.on('text-change', handler);

    return () => {
      quill.off('text-change', handler);
    };
  }, [socket, quill]);

  // 5. Handle incoming changes: Update Quill
  useEffect(() => {
    if (socket == null || quill == null) return;

    const handler = (delta) => {
      quill.updateContents(delta);
    };

    socket.on('receive-changes', handler);

    return () => {
      socket.off('receive-changes', handler);
    };
  }, [socket, quill]);

  // 6. Handle Document Title Updates from Local
  const handleTitleChange = (e) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    setSaveStatus('saving');
    
    if (socket) {
      socket.emit('send-title-changes', newTitle);
      socket.emit('save-title', newTitle);
      // Immediately set save status as saved since socket title save is instant
      setTimeout(() => setSaveStatus('saved'), 500);
    }
  };

  // 7. Receive Title Changes from other users
  useEffect(() => {
    if (socket == null) return;

    const handler = (newTitle) => {
      setTitle(newTitle);
    };

    socket.on('receive-title-changes', handler);

    return () => {
      socket.off('receive-title-changes', handler);
    };
  }, [socket]);

  // 8. Auto-save document content to database
  useEffect(() => {
    if (socket == null || quill == null) return;

    const interval = setInterval(() => {
      if (saveStatus === 'saving') {
        socket.emit('save-document', quill.getContents());
        setSaveStatus('saved');
      }
    }, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [socket, quill, saveStatus]);

  // 9. Copy Share Room Link to Clipboard
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
            {/* Active Users Avatars Placeholder */}
            <div className="hidden sm:flex items-center -space-x-2 mr-2">
              <div 
                className="w-8 h-8 rounded-full bg-purple-500 text-white flex items-center justify-center font-semibold text-xs border-2 border-white shadow-sm cursor-help"
                title="You (Collaborator)"
              >
                AK
              </div>
              <div 
                className="w-8 h-8 rounded-full bg-indigo-500 text-white flex items-center justify-center font-semibold text-xs border-2 border-white shadow-sm cursor-help"
                title="Jane Doe (Editor)"
              >
                JD
              </div>
              <div 
                className="w-8 h-8 rounded-full bg-pink-500 text-white flex items-center justify-center font-semibold text-xs border-2 border-white shadow-sm cursor-help"
                title="Sam Wilson (Viewer)"
              >
                SW
              </div>
              <div 
                className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center font-semibold text-[10px] border-2 border-white shadow-sm cursor-help"
                title="2 other active editors"
              >
                +2
              </div>
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
          
          {/* Main Quill editor mount point */}
          <div ref={wrapperRef} className="mt-4" />
        </div>
      </main>
    </div>
  );
};

export default TextEditor;
