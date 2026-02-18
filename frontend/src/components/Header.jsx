/**
 * Header - Persistent navigation header with auth controls
 * 
 * Always shows:
 * - App branding
 * - User dropdown (email, billing, settings, sign out)
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';

export function Header({ onSignIn, onSignUp, onSignOut }) {
  const { user, isAuthenticated, isAdmin, isMember, isVisitor, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const handleSignOut = async () => {
    setMenuOpen(false);
    await signOut();
    if (onSignOut) onSignOut();
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Determine user badge
  let badge = null;
  let badgeLabel = '';
  if (isAdmin) {
    badge = <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Admin</span>;
    badgeLabel = 'Admin';
  } else if (isMember) {
    badge = <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Member</span>;
    badgeLabel = 'Member';
  } else if (isAuthenticated && isVisitor) {
    badge = <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Visitor</span>;
    badgeLabel = 'Visitor';
  }

  return (
    <header className="bg-white/80 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-10">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <span className="text-2xl">🌍</span>
          <span className="font-bold text-xl text-primary">Exbabel</span>
        </div>

        {/* Auth Controls */}
        <div className="flex items-center gap-3">
          {isAuthenticated ? (
            <div className="relative" ref={menuRef}>
              {/* Clickable user area — triggers dropdown */}
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 cursor-pointer px-2 py-1 rounded-md hover:bg-gray-100 transition-colors"
              >
                <span className="hidden sm:inline">{user?.email}</span>
                {badge}
                {/* Hamburger / triple-line icon */}
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>

              {/* Dropdown menu */}
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                  {/* User info header */}
                  <div className="px-4 py-2 border-b border-gray-100">
                    <p className="text-sm font-medium text-gray-900 truncate">{user?.email}</p>
                    <p className="text-xs text-gray-500">{badgeLabel}</p>
                  </div>

                  {/* Billing — admin only */}
                  {isAdmin && (
                    <a
                      href="/billing"
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      onClick={() => setMenuOpen(false)}
                    >
                      💳 Billing &amp; Usage
                    </a>
                  )}

                  {/* Settings — admin only */}
                  {isAdmin && (
                    <a
                      href="/settings"
                      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      onClick={() => setMenuOpen(false)}
                    >
                      ⚙️ Settings
                    </a>
                  )}

                  {/* Sign Out */}
                  <button
                    onClick={handleSignOut}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                  >
                    🚪 Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onSignIn}
              >
                Sign In
              </Button>
              <Button
                size="sm"
                onClick={onSignUp}
              >
                Sign Up
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
