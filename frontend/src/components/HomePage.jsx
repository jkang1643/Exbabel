/**
 * Home Page - Mode selection for the app
 */

import { useState } from 'react';
import { Header } from './Header';
import { JoinSessionModal } from './JoinSessionModal';

export function HomePage({ onSelectMode }) {
  const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);

  const handleJoin = (code) => {
    if (code && code.trim()) {
      onSelectMode('listener', code.toUpperCase());
      setIsJoinModalOpen(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100">
      <Header />

      <div className="container mx-auto px-3 sm:px-4 py-6 sm:py-12">
        <div className="max-w-4xl mx-auto">
          {/* Welcome Section */}
          <div className="text-center mb-8 sm:mb-12">
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-gray-800 mb-3 sm:mb-4">
              Welcome to Exbabel
            </h1>
            <p className="text-base sm:text-lg md:text-xl text-gray-600">
              Live translation for everyone, everywhere
            </p>
          </div>

          {/* Mode Selection Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 md:gap-8 mb-6 sm:mb-8">
            {/* Solo Mode */}
            <div className="bg-white rounded-lg shadow-xl p-4 sm:p-6 md:p-8 hover:shadow-2xl transition-shadow">
              <div className="text-4xl sm:text-5xl md:text-6xl mb-3 sm:mb-4 text-center">🎧</div>
              <h2 className="text-xl sm:text-xl md:text-2xl font-bold text-gray-800 mb-2 sm:mb-3 text-center">
                Solo Mode
              </h2>
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6 text-center">
                Use translation for yourself. Perfect for personal conversations, learning, or practicing languages.
              </p>
              <button
                onClick={() => onSelectMode('solo')}
                className="w-full px-4 sm:px-6 py-2 sm:py-3 bg-blue-500 hover:bg-blue-600 text-white text-sm sm:text-base font-semibold rounded-lg shadow-lg transition-all transform hover:scale-105"
              >
                Start Solo Session
              </button>
            </div>

            {/* Host Mode */}
            <div className="bg-white rounded-lg shadow-xl p-4 sm:p-6 md:p-8 hover:shadow-2xl transition-shadow">
              <div className="text-4xl sm:text-5xl md:text-6xl mb-3 sm:mb-4 text-center">🎙️</div>
              <h2 className="text-xl sm:text-xl md:text-2xl font-bold text-gray-800 mb-2 sm:mb-3 text-center">
                Host Mode
              </h2>
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6 text-center">
                Start a live session for preaching, conferences, or presentations. Share translations with many listeners.
              </p>
              <button
                onClick={() => onSelectMode('host')}
                className="w-full px-4 sm:px-6 py-2 sm:py-3 bg-red-500 hover:bg-red-600 text-white text-sm sm:text-base font-semibold rounded-lg shadow-lg transition-all transform hover:scale-105"
              >
                Start Broadcasting
              </button>
            </div>
          </div>

          {/* Join Session Section */}
          <div className="bg-white rounded-lg shadow-xl p-4 sm:p-6 md:p-8">
            <div className="text-4xl sm:text-5xl md:text-6xl mb-3 sm:mb-4 text-center">📱</div>
            <h2 className="text-xl sm:text-xl md:text-2xl font-bold text-gray-800 mb-2 sm:mb-3 text-center">
              Join a Session
            </h2>
            <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6 text-center">
              Enter a session code to receive live translations
            </p>

            <div className="max-w-md mx-auto">
              <button
                onClick={() => setIsJoinModalOpen(true)}
                className="w-full px-6 sm:px-8 py-3 sm:py-4 bg-emerald-500 hover:bg-emerald-600 text-white text-lg sm:text-xl font-bold rounded-lg shadow-lg transition-all transform hover:scale-105 flex items-center justify-center gap-3"
              >
                <span>Tap to Join Session</span>
              </button>
            </div>
          </div>

          {/* Feature Highlights */}
          <div className="mt-8 sm:mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
            <div className="text-center bg-white/50 rounded-lg p-3 sm:p-0 sm:bg-transparent">
              <div className="text-3xl sm:text-4xl mb-1 sm:mb-2">🌍</div>
              <h3 className="font-semibold text-sm sm:text-base text-gray-800 mb-1">180+ Languages</h3>
              <p className="text-xs sm:text-sm text-gray-600">Comprehensive global language coverage</p>
            </div>
            <div className="text-center bg-white/50 rounded-lg p-3 sm:p-0 sm:bg-transparent">
              <div className="text-3xl sm:text-4xl mb-1 sm:mb-2">⚡</div>
              <h3 className="font-semibold text-sm sm:text-base text-gray-800 mb-1">Real-time</h3>
              <p className="text-xs sm:text-sm text-gray-600">Instant translations as you speak</p>
            </div>
            <div className="text-center bg-white/50 rounded-lg p-3 sm:p-0 sm:bg-transparent">
              <div className="text-3xl sm:text-4xl mb-1 sm:mb-2">👥</div>
              <h3 className="font-semibold text-sm sm:text-base text-gray-800 mb-1">Multi-user</h3>
              <p className="text-xs sm:text-sm text-gray-600">Broadcast to unlimited listeners</p>
            </div>
          </div>
        </div>
      </div>

      <JoinSessionModal
        isOpen={isJoinModalOpen}
        onClose={() => setIsJoinModalOpen(false)}
        onJoin={handleJoin}
      />
    </div>
  );
}
