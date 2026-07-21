/** @xript oneline.alpha */
export function alpha(x: string): void {
	return;
}

/** @xript oneline.beta */
export function beta(n: number): boolean {
	return n > 0;
}

/**
 * An exported arrow-function binding.
 * @xript arrowns.transfer
 * @xript-cap move
 */
export const transfer = async (from: string, amount: number): Promise<boolean> => {
	return amount > 0;
};

/** @xript arrowns.leaf */
export const leaf = (): string => "hi";
