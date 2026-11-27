// The board reports its host OS. Backslashes remain valid filename characters on Unix.
export const pickerPath = (text: string, windows: boolean) => windows ? text.replaceAll("\\", "/") : text;
