import { useState, useEffect } from 'react';

export function AudioDebugOverlay() {
    const [logs, setLogs] = useState([]);
    const [isVisible, setIsVisible] = useState(true);

    useEffect(() => {
        // Poll for changes since it's a simple global array
        const interval = setInterval(() => {
            if (window.__AUDIO_DEBUG__) {
                setLogs([...window.__AUDIO_DEBUG__]);
            }
        }, 500);

        return () => clearInterval(interval);
    }, []);

    if (!isVisible) {
        return (
            <button
                onClick={() => setIsVisible(true)}
                className="fixed bottom-4 left-4 z-50 bg-black text-white px-2 py-1 text-xs rounded opacity-50"
            >
                Show Debug
            </button>
        );
    }

    return (
        <div className="fixed bottom-4 left-4 right-4 z-50 bg-black/80 text-green-400 p-2 rounded max-h-64 overflow-y-auto pointer-events-auto shadow-lg border border-gray-700">
            <div className="flex justify-between items-center mb-2 pb-1 border-b border-gray-600">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">Audio Debug Logs</h3>
                <button
                    onClick={() => setIsVisible(false)}
                    className="text-gray-400 hover:text-white px-2 text-xs"
                >
                    Hide
                </button>
            </div>
            <div className="space-y-1 font-mono text-[10px] sm:text-xs">
                {logs.length === 0 ? (
                    <div className="text-gray-500 italic">No logs yet...</div>
                ) : (
                    logs.map((log, i) => (
                        <div key={i} className="break-words">
                            <span className="text-gray-500">[{log.t}]</span>{' '}
                            <span className="text-green-300 font-semibold">{log.msg}</span>
                            {log.data && (
                                <span className="text-gray-400 pl-1 block sm:inline">
                                    {JSON.stringify(log.data)}
                                </span>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
