import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute, RedirectAuthenticated } from './components/ProtectedRoute';
import Dashboard from './components/Dashboard';
import TextEditor from './components/TextEditor';
import AuthPage from './components/AuthPage';
import AuthSuccess from './components/AuthSuccess';

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          {/* Public Auth Routes (Redirect if already logged in) */}
          <Route
            path="/login"
            element={
              <RedirectAuthenticated>
                <AuthPage />
              </RedirectAuthenticated>
            }
          />
          <Route path="/auth/success" element={<AuthSuccess />} />

          {/* Protected Main Workspace Routes */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/document/:id"
            element={
              <ProtectedRoute>
                <TextEditor />
              </ProtectedRoute>
            }
          />

          {/* Catch-all Redirect */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
