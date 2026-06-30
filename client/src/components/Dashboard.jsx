import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Plus, FileText, Trash2, MoreVertical, Search, 
  ArrowUpDown, X, Edit3, Link, Printer, Check, AlertTriangle 
} from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';

const Dashboard = () => {
  const navigate = useNavigate();

  // State Management
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Filtering & Sorting State
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('lastEdited'); // 'lastEdited' | 'titleAsc' | 'titleDesc'
  
  // Dropdown & Modals State
  const [activeMenuId, setActiveMenuId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  
  // Rename Modal State
  const [renameDoc, setRenameDoc] = useState(null); // { id, title }
  const [renameTitle, setRenameTitle] = useState('');
  
  // Delete Modal State
  const [deleteDoc, setDeleteDoc] = useState(null); // { id, title }

  const dropdownRef = useRef(null);

  // 1. Fetch live documents from API
  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/documents`);
      if (!res.ok) throw new Error('Failed to fetch documents');
      const data = await res.json();
      setDocuments(data);
      setError(null);
    } catch (err) {
      console.error(err);
      setError('Could not connect to database. Ensure server is running.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  // 2. Close dropdowns on clicking outside
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setActiveMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // 3. Create Document Handler
  const handleCreateDocument = () => {
    const newId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
    navigate(`/documents/${newId}`);
  };

  // 4. Delete Document Handler
  const confirmDelete = async () => {
    if (!deleteDoc) return;
    try {
      const res = await fetch(`${API_BASE}/documents/${deleteDoc.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDocuments(documents.filter((doc) => doc._id !== deleteDoc.id));
        setDeleteDoc(null);
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  // 5. Rename Document Handler
  const confirmRename = async () => {
    if (!renameDoc || !renameTitle.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/documents/${renameDoc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: renameTitle.trim() }),
      });
      if (res.ok) {
        setDocuments(
          documents.map((doc) => 
            doc._id === renameDoc.id ? { ...doc, title: renameTitle.trim() } : doc
          )
        );
        setRenameDoc(null);
        setRenameTitle('');
      }
    } catch (err) {
      console.error('Rename error:', err);
    }
  };

  // 6. Copy Link Handler
  const handleCopyLink = (e, id) => {
    e.stopPropagation();
    const link = `${window.location.origin}/documents/${id}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopiedId(id);
      setActiveMenuId(null);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  // 7. Print Handler
  const handlePrint = (e, id) => {
    e.stopPropagation();
    setActiveMenuId(null);
    // Opens document in a print-ready blank tab
    const printWindow = window.open(`/documents/${id}`, '_blank');
    if (printWindow) {
      // Set a tiny delay so Quill can initialize and populate data before print dialog triggers
      printWindow.onload = () => {
        setTimeout(() => {
          printWindow.print();
        }, 1500);
      };
    }
  };

  // Helper: Format DateTime relatively
  const formatTime = (isoString) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Filter & Sort Calculations
  const filteredDocs = documents.filter((doc) =>
    (doc.title || 'Untitled Document')
      .toLowerCase()
      .includes(searchQuery.toLowerCase())
  );

  const sortedDocs = [...filteredDocs].sort((a, b) => {
    if (sortBy === 'lastEdited') {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    }
    if (sortBy === 'titleAsc') {
      return (a.title || 'Untitled Document').localeCompare(b.title || 'Untitled Document');
    }
    if (sortBy === 'titleDesc') {
      return (b.title || 'Untitled Document').localeCompare(a.title || 'Untitled Document');
    }
    return 0;
  });

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans">
      {/* Navbar */}
      <nav className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm sticky top-0 z-10">
        <div className="flex items-center space-x-3">
          <div className="bg-purple-600 text-white p-2.5 rounded-xl shadow-md shadow-purple-100">
            <FileText className="w-6 h-6" />
          </div>
          <span className="text-xl font-bold tracking-tight text-slate-900">CollabEdit</span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="w-10 h-10 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center font-bold text-sm border-2 border-purple-200 shadow-inner">
            AK
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-6xl w-full mx-auto px-6 py-10 flex-1">
        {/* Create Document Section */}
        <section className="mb-12">
          <h2 className="text-xs font-bold text-slate-400 mb-5 uppercase tracking-wider">Start a New Document</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
            <button
              onClick={handleCreateDocument}
              className="flex flex-col items-center justify-center h-44 bg-white border-2 border-dashed border-slate-200 rounded-2xl hover:border-purple-500 hover:bg-purple-50/20 transition-all duration-300 group cursor-pointer shadow-sm hover:shadow-md"
            >
              <div className="bg-purple-100 text-purple-600 p-4 rounded-full group-hover:scale-110 transition-transform duration-300 shadow-sm shadow-purple-50">
                <Plus className="w-8 h-8" />
              </div>
              <span className="mt-4 font-semibold text-slate-700 group-hover:text-purple-600 transition-colors">
                Blank Document
              </span>
            </button>
          </div>
        </section>

        {/* Database Error Banner */}
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-4 mb-8 flex items-center space-x-3">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0" />
            <span className="font-medium text-sm">{error}</span>
          </div>
        )}

        {/* Recent Documents Section */}
        <section>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-5 mb-6 gap-4">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Recent Documents</h2>
            
            {/* Search and Sort Toolbar */}
            <div className="flex items-center space-x-3 w-full sm:w-auto">
              {/* Search input */}
              <div className="relative flex-1 sm:flex-initial">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg pl-9 pr-8 py-1.5 text-sm w-full sm:w-60 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
                />
                {searchQuery && (
                  <button 
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* Sort selector */}
              <div className="relative">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="bg-white border border-slate-200 rounded-lg pl-8 pr-3 py-1.5 text-sm appearance-none focus:outline-none focus:border-purple-500 cursor-pointer shadow-sm"
                >
                  <option value="lastEdited">Last Edited</option>
                  <option value="titleAsc">Title: A-Z</option>
                  <option value="titleDesc">Title: Z-A</option>
                </select>
                <ArrowUpDown className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Loading Shimmer State */}
          {loading && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
              {[1, 2, 3].map((n) => (
                <div key={n} className="bg-white border border-slate-100 rounded-xl p-5 h-40 flex flex-col justify-between animate-pulse">
                  <div className="flex justify-between items-start">
                    <div className="bg-slate-100 w-10 h-10 rounded-lg"></div>
                    <div className="bg-slate-100 w-6 h-6 rounded-full"></div>
                  </div>
                  <div>
                    <div className="bg-slate-100 h-4 w-3/4 rounded mb-2"></div>
                    <div className="bg-slate-100 h-3 w-1/3 rounded"></div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Documents Grid */}
          {!loading && sortedDocs.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
              {sortedDocs.map((doc) => (
                <div
                  key={doc._id}
                  onClick={() => navigate(`/documents/${doc._id}`)}
                  className="bg-white border border-slate-200 rounded-xl p-5 hover:border-purple-400 hover:shadow-md transition-all duration-300 cursor-pointer group flex flex-col justify-between h-40 relative"
                >
                  <div className="flex items-start justify-between">
                    <div className="bg-purple-50 text-purple-600 p-2.5 rounded-lg group-hover:bg-purple-100 transition-colors shrink-0 shadow-sm shadow-purple-50/50">
                      <FileText className="w-5 h-5" />
                    </div>

                    {/* Copied Link Tooltip Notification */}
                    {copiedId === doc._id && (
                      <span className="bg-emerald-600 text-white text-[10px] px-2 py-1 rounded shadow-md absolute right-12 top-5 flex items-center space-x-1 animate-fade-in z-10">
                        <Check className="w-3 h-3" />
                        <span>Link copied!</span>
                      </span>
                    )}

                    {/* 3-Dots Action Button */}
                    <div className="relative" ref={activeMenuId === doc._id ? dropdownRef : null}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMenuId(activeMenuId === doc._id ? null : doc._id);
                        }}
                        className={`text-slate-400 hover:text-slate-700 hover:bg-slate-100 p-1.5 rounded-lg transition-colors cursor-pointer ${
                          activeMenuId === doc._id ? 'bg-slate-100 text-slate-700' : ''
                        }`}
                      >
                        <MoreVertical className="w-4.5 h-4.5" />
                      </button>

                      {/* Dropdown Menu */}
                      {activeMenuId === doc._id && (
                        <div className="absolute right-0 mt-1.5 w-44 bg-white border border-slate-200 rounded-lg shadow-lg py-1.5 z-20 animate-fade-in font-medium text-slate-600 text-sm">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameDoc({ id: doc._id, title: doc.title || 'Untitled Document' });
                              setRenameTitle(doc.title || 'Untitled Document');
                              setActiveMenuId(null);
                            }}
                            className="w-full text-left px-4 py-2 hover:bg-slate-50 hover:text-purple-600 flex items-center space-x-2 transition-colors cursor-pointer"
                          >
                            <Edit3 className="w-4 h-4 text-slate-400 group-hover:text-purple-600" />
                            <span>Rename</span>
                          </button>
                          
                          <button
                            onClick={(e) => handleCopyLink(e, doc._id)}
                            className="w-full text-left px-4 py-2 hover:bg-slate-50 hover:text-purple-600 flex items-center space-x-2 transition-colors cursor-pointer"
                          >
                            <Link className="w-4 h-4 text-slate-400" />
                            <span>Copy link</span>
                          </button>

                          <button
                            onClick={(e) => handlePrint(e, doc._id)}
                            className="w-full text-left px-4 py-2 hover:bg-slate-50 hover:text-purple-600 flex items-center space-x-2 transition-colors cursor-pointer"
                          >
                            <Printer className="w-4 h-4 text-slate-400" />
                            <span>Print</span>
                          </button>

                          <div className="border-t border-slate-100 my-1"></div>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteDoc({ id: doc._id, title: doc.title || 'Untitled Document' });
                              setActiveMenuId(null);
                            }}
                            className="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 flex items-center space-x-2 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4 text-red-400" />
                            <span>Delete</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="mt-4">
                    <h3 className="font-semibold text-slate-800 group-hover:text-purple-600 transition-colors truncate text-sm md:text-base">
                      {doc.title || 'Untitled Document'}
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">Edited {formatTime(doc.updatedAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty State */}
          {!loading && sortedDocs.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center max-w-lg mx-auto mt-6 shadow-sm">
              <div className="bg-slate-50 text-slate-400 p-4 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4 border border-slate-100">
                <FileText className="w-8 h-8" />
              </div>
              <h3 className="text-base font-bold text-slate-700">No documents found</h3>
              <p className="text-slate-400 text-sm mt-1.5 max-w-sm mx-auto">
                {searchQuery 
                  ? `No matches found for "${searchQuery}". Check your spelling or clear the filter.` 
                  : "Click \"Blank Document\" above to create your first collaborative rich-text document."}
              </p>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="mt-4 text-xs font-semibold text-purple-600 hover:text-purple-700 bg-purple-50 hover:bg-purple-100/70 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                >
                  Clear Search Filter
                </button>
              )}
            </div>
          )}
        </section>
      </main>

      {/* RENAME MODAL */}
      {renameDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md border border-slate-100 overflow-hidden transform scale-100 transition-all duration-300">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">Rename Document</h3>
              <button 
                onClick={() => setRenameDoc(null)}
                className="text-slate-400 hover:text-slate-600 p-1 hover:bg-slate-50 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">New Title</label>
              <input
                type="text"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
              />
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end space-x-3">
              <button
                onClick={() => setRenameDoc(null)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmRename}
                disabled={!renameTitle.trim()}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold shadow-sm shadow-purple-100 transition-colors cursor-pointer"
              >
                Save Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {deleteDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-fade-in">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md border border-slate-100 overflow-hidden transform scale-100 transition-all duration-300">
            <div className="p-6 flex items-start space-x-4">
              <div className="bg-rose-100 text-rose-600 p-3 rounded-full shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-slate-800 text-lg">Delete Document?</h3>
                <p className="text-slate-400 text-sm mt-1.5">
                  Are you sure you want to delete <strong className="text-slate-700">"{deleteDoc.title}"</strong>? This will permanently erase the document contents from our servers. This action is irreversible.
                </p>
              </div>
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end space-x-3">
              <button
                onClick={() => setDeleteDoc(null)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-sm font-semibold shadow-sm shadow-rose-100 transition-colors cursor-pointer"
              >
                Delete Document
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
