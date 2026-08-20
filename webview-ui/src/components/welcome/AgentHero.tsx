const AgentHero = () => {
	return (
		<div className="mb-4 flex items-center gap-2 pt-4">
			<svg
				width="28"
				height="28"
				viewBox="0 0 24 24"
				fill="none"
				stroke="var(--vscode-foreground)"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round">
				<path d="M12 2a4 4 0 0 1 4 4v2H8V6a4 4 0 0 1 4-4z" />
				<rect x="4" y="8" width="16" height="12" rx="2" />
				<circle cx="9" cy="14" r="1.5" fill="var(--vscode-foreground)" stroke="none" />
				<circle cx="15" cy="14" r="1.5" fill="var(--vscode-foreground)" stroke="none" />
				<path d="M10 18h4" />
			</svg>
		</div>
	)
}

export default AgentHero
