export interface EnvironmentGroup {
    name: string
    stacks: string[]
    title?: string    // defaults to name if not set
}

export interface CdkDiaTheme {
    companyName?: string
    logoPath?: string
    logoPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    primaryColor?: string
    clusterBaseColor?: string
    fontName?: string
    title?: string
    footer?: string
    environments?: EnvironmentGroup[]
    /**
     * Rename CDK stack cluster labels. Keys are the CDK stack construct ID
     * (e.g. "LvNetworkStack"), values are the display label shown in the diagram.
     */
    stackLabels?: Record<string, string>
    /**
     * Construct labels to remove from the diagram. Supports exact match or
     * substring match against the component's display label. Useful for hiding
     * lookup-only imports (secrets, SSM params) and CDK boilerplate nodes.
     */
    hideComponents?: string[]
    /**
     * When true, renders using the AWS topology mode: VPC as outer boundary,
     * with Public / Private / Isolated subnet zones, resources placed in their
     * actual subnet. Bypasses the CDK-stack-hierarchy rendering entirely.
     */
    topology?: boolean
}

export const DEFAULT_THEME: CdkDiaTheme = {
    logoPosition: 'top-left',
    primaryColor: '#D58714',
    clusterBaseColor: '#F3F3F3',
    fontName: 'Sans-Serif',
}
