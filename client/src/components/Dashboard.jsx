import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileText, Trash2 } from 'lucide-react';

const Dashboard = () => {
  const navigate = useNavigate();

  // Placeholder data for recent documents
  const recentDocuments = [
    { id: 'doc-1', title: 'Project Proposal', lastEdited: '2 hours ago' },
    { id: 'doc-2', title: 'Meeting Notes - Team', lastEdited: 'Yesterday' },
    { id: 'doc-3', title: 'API Specification', lastEdited: '3 days ago' },
    { id: 'doc-4', title: 'Weekly Update Report', lastEdited: 'Last week' }
  ];

  const handleCreateDocument = () => {
    const newId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
    navigate(`/documents/${newId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      {/* Navbar */}
      <nav className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="bg-purple-600 text-white p-2 rounded-lg">
            <FileText className="w-6 h-6" />
          </div>
          <span className="text-xl font-bold tracking-tight text-gray-900">CollabEdit</span>
        </div>
        <div className="flex items-center space-x-4">
          <div className="w-9 h-9 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center font-semibold text-sm border border-purple-200 shadow-inner">
            AK
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-6xl w-full mx-auto px-6 py-10 flex-1">
        {/* Create Document Section */}
        <section className="mb-12">
          <h2 className="text-xs font-semibold text-gray-400 mb-6 uppercase tracking-wider">Start a New Document</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
            <button
              onClick={handleCreateDocument}
              className="flex flex-col items-center justify-center h-44 bg-white border-2 border-dashed border-gray-200 rounded-xl hover:border-purple-500 hover:bg-purple-50/30 transition-all duration-300 group cursor-pointer shadow-sm hover:shadow-md"
            >
              <div className="bg-purple-100 text-purple-600 p-4 rounded-full group-hover:scale-110 transition-transform duration-300">
                <Plus className="w-8 h-8" />
              </div>
              <span className="mt-4 font-medium text-gray-700 group-hover:text-purple-600 transition-colors">
                Blank Document
              </span>
            </button>
          </div>
        </section>

        {/* Recent Documents Section */}
        <section>
          <h2 className="text-xs font-semibold text-gray-400 mb-6 uppercase tracking-wider">Recent Documents</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
            {recentDocuments.map((doc) => (
              <div
                key={doc.id}
                onClick={() => navigate(`/documents/${doc.id}`)}
                className="bg-white border border-gray-200 rounded-xl p-5 hover:border-purple-400 hover:shadow-md transition-all duration-300 cursor-pointer group flex flex-col justify-between h-40"
              >
                <div className="flex items-start justify-between">
                  <div className="bg-purple-50 text-purple-600 p-2.5 rounded-lg group-hover:bg-purple-100 transition-colors">
                    <FileText className="w-5 h-5" />
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      // Delete placeholder handler
                    }}
                    className="text-gray-400 hover:text-red-500 p-1.5 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                
                <div className="mt-4">
                  <h3 className="font-semibold text-gray-800 group-hover:text-purple-600 transition-colors truncate">
                    {doc.title}
                  </h3>
                  <p className="text-xs text-gray-400 mt-1">Edited {doc.lastEdited}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};

export default Dashboard;
