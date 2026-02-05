/**
 * Header - Persistent navigation header with auth controls
 * 
 * Always shows:
 * - App branding
 * - Sign in/out button
 * - User email when signed in
 */

import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';

export function Header({ onSignIn, onSignUp, onSignOut }) {
  const { user, isAuthenticated, isAdmin, isMember, isVisitor, signOut } = useAuth();

  const handleSignOut = async () => {
    await signOut();
    if (onSignOut) onSignOut();
  };

  // Determine user badge
  let badge = null;
  if (isAdmin) {
    badge = <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Admin</span>;
  } else if (isMember) {
    badge = <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Member</span>;
  } else if (isAuthenticated && isVisitor) {
    badge = <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Visitor</span>;
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
            <>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="hidden sm:inline">{user?.email}</span>
                {badge}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSignOut}
              >
                Sign Out
              </Button>
            </>
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
