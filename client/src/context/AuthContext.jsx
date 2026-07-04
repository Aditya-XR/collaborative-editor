import React, { createContext, useState, useEffect, useContext, useCallback } from 'react';

const AuthContext = createContext(null);

const API_BASE = 'http://localhost:5000/api';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  // Helper to refresh access token
  const refreshAccessToken = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        setToken(data.accessToken);
        setUser(data.user);
        return data.accessToken;
      } else {
        // Clear token if refresh fails
        setToken(null);
        setUser(null);
        return null;
      }
    } catch (err) {
      console.error('Refresh token error:', err);
      setToken(null);
      setUser(null);
      return null;
    }
  }, []);

  // Check auth state on initial mount
  useEffect(() => {
    const initAuth = async () => {
      await refreshAccessToken();
      setLoading(false);
    };
    initAuth();
  }, [refreshAccessToken]);

  // Set up periodic silent token refresh
  useEffect(() => {
    if (token) {
      // Access token expires in 15 mins; refresh every 14 mins
      const interval = setInterval(() => {
        refreshAccessToken();
      }, 14 * 60 * 1000);
      return () => clearInterval(interval);
    }
  }, [token, refreshAccessToken]);

  // Login handler
  const login = async (email, password) => {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, message: data.message || 'Login failed' };
      }
      setToken(data.accessToken);
      setUser(data.user);
      return { success: true };
    } catch (err) {
      console.error('Login request error:', err);
      return { success: false, message: 'Server is unreachable' };
    }
  };

  // Register handler
  const register = async (name, email, password) => {
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, message: data.message || 'Registration failed' };
      }
      setToken(data.accessToken);
      setUser(data.user);
      return { success: true };
    } catch (err) {
      console.error('Register request error:', err);
      return { success: false, message: 'Server is unreachable' };
    }
  };

  // Logout handler
  const logout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    } catch (err) {
      console.error('Logout request error:', err);
    } finally {
      setToken(null);
      setUser(null);
    }
  };

  // Custom authenticated fetch wrapper that handles token injection and automatic token refresh rotation
  const authFetch = useCallback(async (url, options = {}) => {
    let headers = { ...options.headers };
    
    // Add current token if exists
    let currentToken = token;
    if (currentToken) {
      headers['Authorization'] = `Bearer ${currentToken}`;
    }

    const fetchOptions = { ...options, headers };
    
    // Check if we need credentials for cookies (needed for logout/refresh/etc if backend CORS is strict)
    fetchOptions.credentials = 'include';

    let res = await fetch(url, fetchOptions);

    // If token expired (401), request a new token and retry once
    if (res.status === 401 && currentToken) {
      console.warn('Access token expired. Retrying with refreshed token...');
      const refreshedToken = await refreshAccessToken();
      if (refreshedToken) {
        headers['Authorization'] = `Bearer ${refreshedToken}`;
        res = await fetch(url, fetchOptions);
      } else {
        // Refresh failed, log out user
        setToken(null);
        setUser(null);
      }
    }

    return res;
  }, [token, refreshAccessToken]);

  const setAccessToken = (newToken) => {
    setToken(newToken);
    // Fetch user details or refresh to load profile
    refreshAccessToken();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        register,
        logout,
        authFetch,
        setAccessToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
