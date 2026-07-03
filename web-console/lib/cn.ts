import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// cn merges conditional class lists and resolves Tailwind conflicts so the last
// utility wins (e.g. cn("px-2", cond && "px-4")).
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
