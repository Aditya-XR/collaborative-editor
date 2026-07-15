import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Mail, Lock, User, LogIn, UserPlus, AlertCircle } from 'lucide-react';

const AuthPage = () => {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const getErrorMessage = (errCode) => {
    if (!errCode) return '';
    switch (errCode) {
      case 'no_code_provided':
        return 'Google OAuth authentication was cancelled or failed (no code provided).';
      case 'google_token_exchange_failed':
        return 'Failed to exchange Google OAuth code. Please verify that GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the server\'s .env file are valid and match the ones used in the Google Cloud Console.';
      case 'google_userinfo_failed':
        return 'Failed to fetch user details from Google user info endpoint.';
      case 'no_token_received':
        return 'Authentication succeeded, but the client did not receive a session token.';
      case 'internal_server_error':
        return 'An internal server error occurred during Google Sign-In. Check server logs.';
      default:
        return `Google login failed (${errCode}). Please try again.`;
    }
  };

  const [error, setError] = useState(getErrorMessage(searchParams.get('error')));
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (isLogin) {
      const res = await login(email, password);
      if (res.success) {
        navigate('/');
      } else {
        setError(res.message);
      }
    } else {
      if (!name.trim()) {
        setError('Name is required');
        setLoading(false);
        return;
      }
      const res = await register(name, email, password);
      if (res.success) {
        navigate('/');
      } else {
        setError(res.message);
      }
    }
    setLoading(false);
  };

  const handleGoogleLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
      const res = await fetch(`${apiUrl}/auth/config`);
      if (!res.ok) {
        throw new Error('Failed to fetch auth config');
      }
      const data = await res.json();
      const clientId = data.googleClientId;
      if (!clientId || clientId === 'your_google_client_id') {
        setError('Google login is not configured on the server. Please add a valid GOOGLE_CLIENT_ID to the server\'s .env file.');
        setLoading(false);
        return;
      }
      
      const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
      const options = {
        redirect_uri: `${apiUrl}/auth/google/callback`,
        client_id: clientId,
        access_type: 'offline',
        response_type: 'code',
        prompt: 'consent',
        scope: [
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/userinfo.email',
        ].join(' '),
      };
      const q = new URLSearchParams(options);
      window.location.href = `${rootUrl}?${q.toString()}`;
    } catch (err) {
      setError('Could not connect to the authentication server to retrieve client ID.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden transition-all duration-300">
        
        {/* Banner Top */}
        <div className="bg-purple-600 px-6 py-8 text-white text-center flex flex-col items-center">
          <div className="bg-white/10 p-3 rounded-full mb-3 shadow-inner">
            <FileText className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">CollabEdit</h2>
          <p className="text-purple-100 text-xs mt-1">Real-time production collaborative editor</p>
        </div>

        {/* Form Body */}
        <div className="p-8">
          <h3 className="text-xl font-bold text-slate-800 text-center mb-6">
            {isLogin ? 'Sign In to Your Account' : 'Create New Account'}
          </h3>

          {error && (
            <div className="bg-rose-50 border border-rose-100 text-rose-700 text-sm rounded-lg p-3.5 mb-5 flex items-start space-x-2.5">
              <AlertCircle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <div className="relative">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">Full Name</label>
                <div className="relative">
                  <User className="w-4.5 h-4.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    placeholder="John Doe"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all bg-slate-50/50"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">Email Address</label>
              <div className="relative">
                <Mail className="w-4.5 h-4.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all bg-slate-50/50"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">Password</label>
              <div className="relative">
                <Lock className="w-4.5 h-4.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all bg-white"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-semibold shadow-md shadow-purple-100 transition-all cursor-pointer flex items-center justify-center space-x-2 mt-6"
            >
              {loading ? (
                <span>Loading...</span>
              ) : isLogin ? (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>Sign In</span>
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  <span>Create Account</span>
                </>
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200"></div>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-3 text-slate-400 font-bold tracking-wider">Or continue with</span>
            </div>
          </div>

          {/* Google Sign In */}
          <button
            onClick={handleGoogleLogin}
            className="w-full bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-lg py-2.5 text-sm font-semibold transition-all cursor-pointer flex items-center justify-center space-x-2.5 shadow-sm"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
            </svg>
            <span>Sign in with Google</span>
          </button>

          <p className="text-center text-sm text-slate-500 mt-6">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button
              onClick={() => {
                setIsLogin(!isLogin);
                setError('');
              }}
              className="text-purple-600 hover:text-purple-700 font-semibold cursor-pointer underline"
            >
              {isLogin ? 'Sign Up' : 'Sign In'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default AuthPage;
