import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Loader2 } from 'lucide-react';

const AuthSuccess = () => {
  const { setAccessToken } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const token = searchParams.get('token');
    if (token) {
      setAccessToken(token);
      navigate('/');
    } else {
      navigate('/login?error=no_token_received');
    }
  }, [searchParams, setAccessToken, navigate]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center font-sans">
      <Loader2 className="w-10 h-10 text-purple-600 animate-spin mb-4" />
      <h3 className="font-bold text-slate-800 text-lg">Authenticating with Google...</h3>
      <p className="text-slate-400 text-sm mt-1">Please wait while we complete the secure handshake.</p>
    </div>
  );
};

export default AuthSuccess;
