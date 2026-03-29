/**
 * Write a message to the application log.
 *
 * @xript log
 * @param message - The message to log
 * @param level - Optional log level
 */
export function log(message: string, level?: string): void {}

/**
 * Get value from the data store by path.
 *
 * @xript data.get
 * @xript-cap read-state
 * @param path - Data path in dot notation
 * @param defaultValue - Fallback value if path not found
 * @returns The stored value
 */
export function getData(path: string, defaultValue?: unknown): unknown {
	return defaultValue;
}

/**
 * Save value to the data store.
 *
 * @xript data.set
 * @xript-cap modify-state
 * @param path - Data path in dot notation
 * @param value - Value to store
 */
export async function setData(path: string, value: unknown): Promise<void> {}

/**
 * Get player health points.
 *
 * @xript player.getHealth
 * @deprecated Use data.get("player.health") instead
 * @returns Current health value
 */
export function getPlayerHealth(): number {
	return 100;
}

export function notAnnotated(): void {}
