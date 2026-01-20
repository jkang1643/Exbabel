/**
 * Minimal typed event emitter
 * 
 * No external dependencies, works in browser and Node.js.
 */

type Listener<T> = (data: T) => void;

/**
 * Simple typed event emitter
 */
export class TypedEmitter<Events extends Record<string, unknown>> {
    private listeners = new Map<keyof Events, Set<Listener<unknown>>>();

    /**
     * Subscribe to an event
     */
    on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(listener as Listener<unknown>);

        // Return unsubscribe function
        return () => this.off(event, listener);
    }

    /**
     * Subscribe to an event (once)
     */
    once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
        const onceListener: Listener<Events[K]> = (data) => {
            this.off(event, onceListener);
            listener(data);
        };
        return this.on(event, onceListener);
    }

    /**
     * Unsubscribe from an event
     */
    off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
        this.listeners.get(event)?.delete(listener as Listener<unknown>);
    }

    /**
     * Emit an event to all subscribers
     */
    protected emit<K extends keyof Events>(event: K, data: Events[K]): void {
        const eventListeners = this.listeners.get(event);
        if (eventListeners) {
            for (const listener of eventListeners) {
                try {
                    listener(data);
                } catch (err) {
                    console.error(`[TypedEmitter] Error in listener for "${String(event)}":`, err);
                }
            }
        }
    }

    /**
     * Remove all listeners for an event (or all events)
     */
    removeAllListeners<K extends keyof Events>(event?: K): void {
        if (event) {
            this.listeners.delete(event);
        } else {
            this.listeners.clear();
        }
    }

    /**
     * Get listener count for an event
     */
    listenerCount<K extends keyof Events>(event: K): number {
        return this.listeners.get(event)?.size ?? 0;
    }
}
