import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind CSS classes with clsx
 * shadcn/ui utility function
 */
export function cn(...inputs) {
    return twMerge(clsx(inputs));
}
