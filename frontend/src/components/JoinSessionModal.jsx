import { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from "html5-qrcode";
import { X, QrCode, Keyboard, ChevronLeft, Camera, AlertCircle } from 'lucide-react';

export function JoinSessionModal({ isOpen, onClose, onJoin }) {
    const [mode, setMode] = useState('selection'); // 'selection', 'scan', 'type'
    const [code, setCode] = useState('');
    const [error, setError] = useState('');
    const [scannerActive, setScannerActive] = useState(false);
    const scannerRef = useRef(null);

    // Cleanup when modal closes or mode changes
    useEffect(() => {
        if (!isOpen || mode !== 'scan') {
            handleStopScanner();
        }

        if (!isOpen) {
            setMode('selection');
            setCode('');
            setError('');
        }
    }, [isOpen, mode]);

    // Final cleanup on unmount
    useEffect(() => {
        return () => {
            handleStopScanner();
        };
    }, []);

    const handleStopScanner = async () => {
        if (scannerRef.current) {
            try {
                if (scannerRef.current.isScanning) {
                    await scannerRef.current.stop();
                }
                const element = document.getElementById("reader");
                if (element) {
                    scannerRef.current.clear();
                    element.innerHTML = "";
                }
            } catch (err) {
                console.warn("Scanner cleanup warning:", err);
            } finally {
                scannerRef.current = null;
                setScannerActive(false);
            }
        }
    };

    const startScanner = async () => {
        setTimeout(async () => {
            const element = document.getElementById("reader");
            if (!element) return;

            try {
                await handleStopScanner();

                const html5QrCode = new Html5Qrcode("reader");
                scannerRef.current = html5QrCode;

                // IMPROVED: Higher FPS and adaptive box size
                const config = {
                    fps: 20, // Faster recognition
                    qrbox: (viewfinderWidth, viewfinderHeight) => {
                        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
                        const qrboxSize = Math.floor(minEdge * 0.8); // Larger box for easier alignment
                        return {
                            width: qrboxSize,
                            height: qrboxSize
                        };
                    },
                    aspectRatio: 1.0
                };

                const onScanSuccess = (decodedText) => {
                    console.log("[Scanner] Decoded text:", decodedText);
                    let sessionCode = decodedText;

                    try {
                        // Try URL parsing first (handles any hostname, not just localhost)
                        const url = new URL(decodedText);
                        const codeParam = url.searchParams.get('code') || url.searchParams.get('join');
                        if (codeParam) {
                            sessionCode = codeParam.toUpperCase();
                        } else if (decodedText.length <= 8 && /^[A-Z0-9]+$/i.test(decodedText)) {
                            // Raw code (no URL wrapping)
                            sessionCode = decodedText.toUpperCase();
                        }
                    } catch (e) {
                        // Not a valid URL — try regex as fallback
                        const match = decodedText.match(/[?&](?:code|join)=([A-Z0-9]{1,6})/i);
                        if (match && match[1]) {
                            sessionCode = match[1].toUpperCase();
                        } else if (decodedText.length <= 8 && /^[A-Z0-9]+$/i.test(decodedText)) {
                            sessionCode = decodedText.toUpperCase();
                        }
                    }

                    console.log("[Scanner] Extracted session code:", sessionCode);
                    handleStopScanner().then(() => {
                        onJoin(sessionCode);
                        onClose();
                    });
                };

                setError('');

                try {
                    await html5QrCode.start(
                        { facingMode: "environment" },
                        config,
                        onScanSuccess,
                        () => { }
                    );
                    setScannerActive(true);
                } catch (e) {
                    await html5QrCode.start(
                        { facingMode: "user" },
                        config,
                        onScanSuccess,
                        () => { }
                    );
                    setScannerActive(true);
                }
            } catch (err) {
                console.error("Scanner start error:", err);
                setError("Camera access failed. Ensure permission is granted.");
                setScannerActive(false);
                if (element) element.innerHTML = "";
            }
        }, 300);
    };

    const handleSubmitCode = (e) => {
        e?.preventDefault();
        if (code.trim().length > 0) {
            onJoin(code);
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden relative flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b">
                    {mode !== 'selection' ? (
                        <button
                            onClick={() => setMode('selection')}
                            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                        >
                            <ChevronLeft size={24} className="text-gray-600" />
                        </button>
                    ) : <div className="w-10" />}

                    <h2 className="text-xl font-bold text-gray-800">
                        {mode === 'selection' && 'Join Session'}
                        {mode === 'scan' && 'Scan QR Code'}
                        {mode === 'type' && 'Enter Code'}
                    </h2>

                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                    >
                        <X size={24} className="text-gray-600" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto">
                    {mode === 'selection' && (
                        <div className="grid grid-cols-1 gap-4">
                            <p className="text-center text-gray-500 mb-2">
                                Choose how you want to connect to the session
                            </p>

                            <button
                                onClick={() => {
                                    setMode('scan');
                                    startScanner();
                                }}
                                className="flex items-center gap-4 p-6 border-2 border-gray-100 rounded-xl hover:border-emerald-500 hover:bg-emerald-50 transition-all group text-left"
                            >
                                <div className="bg-emerald-100 p-4 rounded-full group-hover:bg-emerald-200 transition-colors">
                                    <Camera size={32} className="text-emerald-600" />
                                </div>
                                <div>
                                    <h3 className="font-bold text-lg text-gray-800">Scan QR Code</h3>
                                    <p className="text-sm text-gray-500">Fastest way to join</p>
                                </div>
                            </button>

                            <button
                                onClick={() => setMode('type')}
                                className="flex items-center gap-4 p-6 border-2 border-gray-100 rounded-xl hover:border-purple-500 hover:bg-purple-50 transition-all group text-left"
                            >
                                <div className="bg-purple-100 p-4 rounded-full group-hover:bg-purple-200 transition-colors">
                                    <Keyboard size={32} className="text-purple-600" />
                                </div>
                                <div>
                                    <h3 className="font-bold text-lg text-gray-800">Enter Code Manually</h3>
                                    <p className="text-sm text-gray-500">Type the 6-character code</p>
                                </div>
                            </button>
                        </div>
                    )}

                    {mode === 'scan' && (
                        <div className="flex flex-col items-center">
                            <div className="relative w-full h-80 mb-6 bg-gray-900 rounded-2xl overflow-hidden shadow-2xl">
                                <div
                                    id="reader"
                                    className="w-full h-full"
                                />

                                {scannerActive && (
                                    <div className="absolute inset-0 pointer-events-none">
                                        <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500/60 shadow-[0_0_20px_rgba(16,185,129,1)] animate-scan-line z-10" />
                                        <div className="absolute inset-0 border-[30px] border-black/40 rounded-2xl" />
                                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 border-2 border-emerald-500/30 rounded-lg" />
                                    </div>
                                )}

                                {!scannerActive && !error && (
                                    <div className="absolute inset-0 flex items-center justify-center text-gray-400 bg-gray-900 z-20">
                                        <div className="flex flex-col items-center gap-3">
                                            <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                                            <span className="text-sm font-medium">Setting up scanner...</span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {error ? (
                                <div className="flex items-center gap-2 text-red-600 bg-red-50 p-4 rounded-xl w-full">
                                    <AlertCircle size={20} />
                                    <span className="text-sm font-semibold">{error}</span>
                                </div>
                            ) : (
                                <div className="text-center space-y-1">
                                    <p className="text-gray-700 font-medium">
                                        Place QR code inside the frame
                                    </p>
                                    <p className="text-xs text-gray-400">
                                        Recognition is automatic once aligned
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {mode === 'type' && (
                        <form onSubmit={handleSubmitCode} className="flex flex-col gap-8">
                            <div className="space-y-4">
                                <label className="block text-center text-sm font-semibold text-gray-500 tracking-wider uppercase">
                                    6-Character Session Code
                                </label>
                                <input
                                    autoFocus
                                    type="text"
                                    value={code}
                                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                                    placeholder="XXXXXX"
                                    maxLength={6}
                                    className="w-full px-4 py-8 text-5xl font-black text-center tracking-[0.4em] border-3 border-gray-100 rounded-3xl focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 focus:outline-none transition-all placeholder:text-gray-100"
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={code.trim().length === 0}
                                className="w-full py-5 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-200 text-white font-black text-xl rounded-2xl shadow-xl shadow-emerald-500/20 transition-all active:scale-[0.98] disabled:shadow-none"
                            >
                                JOIN NOW
                            </button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}
