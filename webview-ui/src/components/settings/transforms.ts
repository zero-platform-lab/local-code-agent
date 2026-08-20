export const noTransform = <T>(value: T) => value

export const inputEventTransform = <E>(event: E) => (event as { target: HTMLInputElement })?.target?.value as any

export const urlInputEventTransform = <E>(event: E) =>
	((event as { target: HTMLInputElement })?.target?.value ?? "").trim() as any
