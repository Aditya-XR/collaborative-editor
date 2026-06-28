import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText } from 'lucide-react';

const TextEditor = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Editor Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate('/')}
            className="text-gray-500 hover:text-gray-700 hover:bg-gray-100 p-2 rounded-lg transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center space-x-3">
            <div className="bg-purple-100 text-purple-700 p-2 rounded-lg">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-semibold text-gray-800 text-sm md:text-base truncate max-w-xs md:max-w-md">
                Document {id}
              </h1>
              <p className="text-xs text-gray-400">Collaborative Workspace</p>
            </div>
          </div>
        </div>
      </header>

      {/* Editor Body Placeholder */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6 flex flex-col">
        <div className="flex-1 bg-white border border-gray-200 rounded-xl shadow-sm p-8 flex flex-col items-center justify-center text-center">
          <div className="animate-pulse bg-purple-100 text-purple-600 p-4 rounded-full mb-4">
            <FileText className="w-10 h-10" />
          </div>
          <h2 className="text-xl font-bold text-gray-800">Rich Text Editor Coming Soon</h2>
          <p className="text-gray-400 mt-2 max-w-sm">
            This workspace will house our collaborative Quill rich-text editor for document ID <code className="bg-gray-100 px-1.5 py-0.5 rounded text-purple-600 font-mono text-sm">{id}</code>.
          </p>
        </div>
      </main>
    </div>
  );
};

export default TextEditor;
