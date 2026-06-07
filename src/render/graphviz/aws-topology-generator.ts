import { digraph, RootGraphModel, SubgraphModel } from 'ts-graphviz'
import * as cdk from '../../cdk'
import { AwsIconSupplier } from '../../diagram/aws/aws-icon-supplier'
import { ComponentIcon, ComponentIconFormat } from '../../diagram/component/icon'
import { CdkDiaTheme } from '../../brand/theme'

// ─── Types ────────────────────────────────────────────────────────────────────

type SubnetType = 'PUBLIC' | 'PRIVATE' | 'ISOLATED'
type Placement = SubnetType | 'VPC' | 'EXTERNAL'

interface SubnetKey {
    constructName: string  // e.g. "publicSubnet1"
    type: SubnetType
}

interface TopologyResource {
    id: string
    label: string
    icon: ComponentIcon | null
    placement: Placement
    logicalId: string
    cfnType: string
    ecsClusterId?: string   // for ECS Services: parent cluster resource ID
}

interface TopologyEdge {
    fromId: string
    toId: string
    dashed: boolean
}

interface NetworkOutput {
    name: string
    value: string
}

// CFN types that are network plumbing / IAM / CDK internals — hidden because they are either
// represented structurally (subnets as zones, VPC as boundary) or are too low-level to appear
// in an architecture diagram.
const TOPOLOGY_HIDDEN_TYPES = new Set([
    // EC2 networking plumbing — subnets shown as zone boundaries, routing is implicit
    'AWS::EC2::Subnet',
    'AWS::EC2::RouteTable',
    'AWS::EC2::SubnetRouteTableAssociation',
    'AWS::EC2::Route',
    'AWS::EC2::EIP',                   // implied by the NAT Gateway node
    'AWS::EC2::VPCGatewayAttachment',
    'AWS::EC2::NetworkAcl',
    'AWS::EC2::SubnetNetworkAclAssociation',
    'AWS::EC2::SecurityGroup',
    'AWS::EC2::SecurityGroupIngress',
    'AWS::EC2::SecurityGroupEgress',
    'AWS::EC2::VPC',                   // shown as the cluster boundary, not a node
    // RDS supporting resources
    'AWS::RDS::DBSubnetGroup',
    'AWS::RDS::DBParameterGroup',
    'AWS::RDS::DBClusterParameterGroup',
    'AWS::RDS::DBInstance',            // Aurora instances implied by the cluster node
    'AWS::RDS::DBProxyTargetGroup',    // plumbing, implied by the proxy
    // ECS supporting resources
    // AWS::ECS::Cluster is NOT hidden — rendered as a subgraph boundary containing its services
    'AWS::ECS::ClusterCapacityProviderAssociations',
    'AWS::ECS::TaskDefinition',        // implied by the ECS Service node
    // ELB supporting resources
    'AWS::ElasticLoadBalancingV2::TargetGroup',
    'AWS::ElasticLoadBalancingV2::Listener',
    // ElastiCache supporting resources
    'AWS::ElastiCache::SubnetGroup',
    'AWS::ElastiCache::ParameterGroup',
    // IAM — policies and instance profiles are too granular; Roles ARE shown as EXTERNAL nodes
    'AWS::IAM::Policy',
    'AWS::IAM::InstanceProfile',
    // Logging — implied
    'AWS::Logs::LogGroup',
    // Secrets Manager supporting resources (the Secret itself IS shown as EXTERNAL)
    'AWS::SecretsManager::SecretTargetAttachment',
    'AWS::SecretsManager::RotationSchedule',
    // Auto-scaling policy detail — implied by the service
    'AWS::ApplicationAutoScaling::ScalableTarget',
    'AWS::ApplicationAutoScaling::ScalingPolicy',
    // Monitoring / alerting — operational concerns separate from architecture
    'AWS::CloudWatch::Alarm',
    'AWS::CloudWatch::Dashboard',
    'AWS::CloudWatch::CompositeAlarm',
    // Messaging detail — kept hidden unless user's app uses SNS as application-level service
    'AWS::SNS::Topic',
    'AWS::SNS::Subscription',
    'AWS::SNS::TopicPolicy',
    // Configuration / parameter store — infrastructure config, not architecture nodes
    'AWS::SSM::Parameter',
    // CDK / CloudFormation internals
    'AWS::CloudFormation::CustomResource',
    'AWS::CDK::Metadata',
])

// Subnet zone visual styling
const ZONE_STYLE: Record<SubnetType, { fill: string; pen: string; label: string }> = {
    PUBLIC:   { fill: '#EAF7EE', pen: '#2E7D32', label: 'Public Subnets' },
    PRIVATE:  { fill: '#E3F2FD', pen: '#1565C0', label: 'Private Subnets' },
    ISOLATED: { fill: '#F3E5F5', pen: '#6A1B9A', label: 'Isolated Subnets' },
}

// CDK construct IDs that are always skipped (boilerplate, not application resources)
const HIDDEN_CONSTRUCT_IDS = new Set([
    'CDKMetadata', 'Exports', 'BootstrapVersion', 'CheckBootstrapVersion', 'ParameterExports',
])

// Resource types excluded from edge detection — their CFN prop references create too many
// false-positive matches (e.g., every cross-stack resource references the network stack name).
const EDGE_EXCLUDED_TYPES = new Set([
    'AWS::EC2::NatGateway',
    'AWS::EC2::InternetGateway',
    'AWS::ECS::Cluster',
])

// Whitelist of hidden CFN types whose props are expanded into the containing visible resource's
// edge-search context.  Only types that carry meaningful cross-service references are included;
// networking-plumbing types (SecurityGroup rules, route tables) are intentionally excluded
// because they contain cross-VPC security-group references that cause false-positive edges.
const EDGE_DETECTION_HIDDEN_TYPES = new Set([
    'AWS::ECS::TaskDefinition',                            // env vars → Redis/DB Proxy endpoints
    'AWS::ElasticLoadBalancingV2::Listener',               // NLB ARN via Fn::ImportValue
    'AWS::ElasticLoadBalancingV2::TargetGroup',            // LB ↔ service bridge
    'AWS::RDS::DBProxyTargetGroup',                        // links DB Proxy to DB Cluster
    'AWS::SecretsManager::SecretTargetAttachment',         // links DB Cluster to its Secret
])

// Depth ordering for bidirectional edge deduplication: prefer edges that flow from shallower
// placements (closer to the internet) to deeper ones (isolated/external data tier).
const PLACEMENT_DEPTH: Record<string, number> = {
    PUBLIC: 0,
    PRIVATE: 1,
    ISOLATED: 2,
    VPC: 3,
    EXTERNAL: 4,
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class AwsTopologyGenerator {

    constructor(private readonly iconSupplier: AwsIconSupplier) {}

    generate(
        cdkTree: cdk.Tree,
        includedStacks: string[],
        theme: CdkDiaTheme,
        cdkOutPath?: string,
    ): RootGraphModel {
        const subnetKeys = this.buildSubnetKeyMap(cdkTree.tree)
        const resources = this.collectResources(cdkTree.tree, includedStacks, subnetKeys, theme)
        this.resolveEcsHierarchy(resources, cdkTree.tree)
        const edges = this.resolveEdges(cdkTree.tree, includedStacks, resources)
        const networkOutputs = cdkOutPath
            ? this.collectNetworkOutputsFromTemplates(cdkOutPath, includedStacks)
            : []
        return this.renderDot(resources, edges, networkOutputs, theme)
    }

    // ── 1. Subnet key map ─────────────────────────────────────────────────────

    private buildSubnetKeyMap(appNode: cdk.Node): SubnetKey[] {
        const keys: SubnetKey[] = []
        appNode.children.forEach(stackNode => {
            stackNode.children.forEach(child => {
                if (child.id !== 'Vpc') return
                child.children.forEach(vpcChild => {
                    const name = vpcChild.id
                    const lower = name.toLowerCase()
                    let type: SubnetType | null = null
                    if (lower.startsWith('public')) type = 'PUBLIC'
                    else if (lower.startsWith('private')) type = 'PRIVATE'
                    else if (lower.startsWith('isolated')) type = 'ISOLATED'
                    if (type && vpcChild.children.has('Subnet')) {
                        keys.push({ constructName: name, type })
                    }
                })
            })
        })
        return keys
    }

    // ── 2. Resource collection ────────────────────────────────────────────────

    private collectResources(
        appNode: cdk.Node,
        includedStacks: string[],
        subnetKeys: SubnetKey[],
        theme: CdkDiaTheme,
    ): TopologyResource[] {
        const resources: TopologyResource[] = []
        const hidePatterns = theme.hideComponents ?? []

        appNode.children.forEach(stackNode => {
            if (!includedStacks.includes(stackNode.id)) return
            this.walkNode(stackNode, null, subnetKeys, hidePatterns, resources)
        })

        return resources
    }

    private walkNode(
        node: cdk.Node,
        parentNode: cdk.Node | null,
        subnetKeys: SubnetKey[],
        hidePatterns: string[],
        out: TopologyResource[],
    ): void {
        if (HIDDEN_CONSTRUCT_IDS.has(node.id)) return

        const cfnType = this.getCfnType(node)
        const resourceChild = node.children.get('Resource')
        const childCfnType = resourceChild ? this.getCfnType(resourceChild) : null
        const effectiveCfnType = cfnType ?? childCfnType

        if (effectiveCfnType) {
            if (TOPOLOGY_HIDDEN_TYPES.has(effectiveCfnType)) {
                // Hidden CFN type — skip this resource, but if the type was inferred from a
                // 'Resource' child (i.e. an L2 construct wrapper), still recurse into the
                // non-Resource children so nested visible resources (e.g. NAT Gateway inside
                // the Vpc L2 construct) are discovered.
                if (cfnType === null) {
                    for (const [childId, child] of node.children) {
                        if (childId !== 'Resource') {
                            this.walkNode(child, node, subnetKeys, hidePatterns, out)
                        }
                    }
                }
                return
            }

            const label = this.labelForNode(node, effectiveCfnType)
            if (hidePatterns.some(p => label === p || label.includes(p))) return

            const effectiveNode = cfnType ? node : resourceChild!
            const cfnProps = this.getCfnProps(effectiveNode)

            // First try direct placement from the resource's own props.
            // If not found, search the parent construct's full subtree (handles indirect
            // references like RDS clusters whose subnet info lives in a sibling DBSubnetGroup).
            let placement = this.detectPlacement(cfnProps, subnetKeys)
            // Internet Gateway has no VPC refs in its own props — force it to VPC level
            if (effectiveCfnType === 'AWS::EC2::InternetGateway') placement = 'VPC'
            if (placement === 'VPC' && parentNode) {
                placement = this.detectPlacementInSubtree(parentNode, subnetKeys)
            }

            const icon = this.iconSupplier.matchIcon(effectiveCfnType, cfnProps as Record<string, string>)
            const id = this.sanitizeId(node.path)
            const logicalId = this.deriveLogicalId(effectiveNode)

            out.push({ id, label, icon, placement, logicalId, cfnType: effectiveCfnType })
            // For L2 constructs (cfnType === null, resource found via Resource child),
            // also recurse into the non-Resource sibling children — they may contain
            // additional visible resources (e.g. a Secret nested inside a Database construct).
            if (cfnType === null) {
                for (const [childId, child] of node.children) {
                    if (childId !== 'Resource') {
                        this.walkNode(child, node, subnetKeys, hidePatterns, out)
                    }
                }
            }
            return
        }

        // No CFN resource at this level — recurse into children
        node.children.forEach(child => {
            this.walkNode(child, node, subnetKeys, hidePatterns, out)
        })
    }

    // Walk all descendant nodes looking for subnet references (used for indirect placement,
    // e.g. RDS cluster whose subnet type is declared in a sibling DBSubnetGroup node).
    private detectPlacementInSubtree(node: cdk.Node, subnetKeys: SubnetKey[]): Placement {
        const props = this.getCfnProps(node)
        const p = this.detectPlacement(props, subnetKeys)
        // Only propagate a definitive subnet-zone result; VPC/EXTERNAL means "keep searching"
        if (p !== 'VPC' && p !== 'EXTERNAL') return p
        for (const [, child] of node.children) {
            const cp = this.detectPlacementInSubtree(child, subnetKeys)
            if (cp !== 'VPC' && cp !== 'EXTERNAL') return cp
        }
        return 'VPC'
    }

    private getCfnType(node: cdk.Node): string | null {
        const t = node.attributes.get('aws:cdk:cloudformation:type')
        return t ? String(t) : null
    }

    private getCfnProps(node: cdk.Node): Record<string, unknown> {
        const p = node.attributes.get('aws:cdk:cloudformation:props')
        return (p && typeof p === 'object') ? p as Record<string, unknown> : {}
    }

    private labelForNode(node: cdk.Node, cfnType: string): string {
        // Walk up the construct path to find the first non-generic, non-stack identifier.
        // e.g. LvWordPressStack/WordPressService/Default/Service → "WordPressService"
        const skip = new Set(['Resource', 'Default', 'Service', 'Writer', 'writer'])
        const pathParts = node.path.split('/')

        // For IAM Roles: find the owning resource name (one level up from Role/TaskRole/ExecutionRole)
        // e.g. DbProxy/IAMRole/Resource → "DB Proxy IAM Role"
        //      WordPressService/Resource/TaskRole/Resource → "Task Role"
        if (cfnType === 'AWS::IAM::Role') {
            let ownerPart: string | null = null
            for (let i = pathParts.length - 1; i >= 1; i--) {
                const part = pathParts[i]
                if (skip.has(part)) continue
                if (part.endsWith('Stack') || part.endsWith('stack')) continue
                if (part.includes('Role') || part === 'IAM') {
                    // This is the role itself — look one more level up for the owner
                    continue
                }
                ownerPart = part
                break
            }
            // Find the role-specific part (IAMRole, TaskRole, ExecutionRole)
            for (let i = pathParts.length - 1; i >= 1; i--) {
                const part = pathParts[i]
                if (part.includes('Role') && part !== 'Resource') {
                    const roleName = this.humanizeLabel(part)
                    return ownerPart ? `${this.humanizeLabel(ownerPart)} ${roleName}` : roleName
                }
            }
        }

        for (let i = pathParts.length - 1; i >= 1; i--) {
            const part = pathParts[i]
            if (skip.has(part)) continue
            if (part.endsWith('Stack') || part.endsWith('stack')) continue
            return this.humanizeLabel(part)
        }
        const parts = cfnType.split('::')
        return parts.length >= 3 ? parts[2] : cfnType
    }

    // Convert PascalCase/camelCase construct IDs to human-readable labels.
    // e.g. DbProxy → DB Proxy, Nlb → NLB, RedisCluster → Redis Cluster
    private humanizeLabel(id: string): string {
        const abbreviations = new Set([
            'NLB', 'ALB', 'ELB', 'DB', 'RDS', 'ECS', 'EKS', 'VPC', 'API',
            'CDN', 'IAM', 'SSM', 'SNS', 'SQS', 'KMS', 'EC2', 'ACM', 'WAF',
            'S3', 'DNS', 'AMI', 'TLS', 'SSL', 'CDK', 'ARN', 'SES', 'SFN',
        ])
        const words = id
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .split(' ')
        const humanized = words.map(w => abbreviations.has(w.toUpperCase()) ? w.toUpperCase() : w).join(' ')
        // Rejoin compound brand/product names that were split by the PascalCase splitter
        return humanized
            .replace(/\bWord Press\b/g, 'WordPress')
    }

    private deriveLogicalId(node: cdk.Node): string {
        return node.path.replace(/[^a-zA-Z0-9]/g, '')
    }

    private sanitizeId(p: string): string {
        return `node_${p.replace(/[^a-zA-Z0-9]/g, '_')}`
    }

    // Match ECS Services to their parent ECS Cluster and update placement.
    // Services reference their cluster via Fn::ImportValue whose key contains the cluster's stack name.
    private resolveEcsHierarchy(resources: TopologyResource[], appNode: cdk.Node): void {
        const clusters = resources.filter(r => r.cfnType === 'AWS::ECS::Cluster')
        const services = resources.filter(r => r.cfnType === 'AWS::ECS::Service')
        if (!clusters.length || !services.length) return

        for (const cluster of clusters) {
            // First path segment after removing 'node_' prefix is the stack name
            const clusterStackName = cluster.id.replace(/^node_/, '').split('_')[0]

            for (const service of services) {
                // Reverse sanitizeId to get the original construct path
                const serviceNodePath = service.id.replace(/^node_/, '').replace(/_/g, '/')
                const serviceNode = this.findNodeByPath(appNode, serviceNodePath)
                if (!serviceNode) continue

                const effectiveNode = serviceNode.children.get('Resource') ?? serviceNode
                const props = this.getCfnProps(effectiveNode)
                const clusterPropJson = JSON.stringify(props['cluster'] ?? '')

                if (clusterPropJson.includes(clusterStackName)) {
                    service.ecsClusterId = cluster.id
                    // The cluster inherits its placement zone from the services inside it
                    if (cluster.placement === 'VPC' || cluster.placement === 'EXTERNAL') {
                        cluster.placement = service.placement
                    }
                }
            }
        }
    }

    // Walk the CDK tree along a slash-separated path (relative to appNode).
    private findNodeByPath(root: cdk.Node, path: string): cdk.Node | null {
        const parts = path.split('/').filter(p => p.length > 0)
        let cur: cdk.Node = root
        for (const part of parts) {
            const child = cur.children.get(part)
            if (!child) return null
            cur = child
        }
        return cur
    }

    // ── 3. Placement detection ────────────────────────────────────────────────

    private detectPlacement(props: Record<string, unknown>, subnetKeys: SubnetKey[]): Placement {
        const json = JSON.stringify(props)
        // Search for VPC subnet construct names in the serialised CFN props string.
        // Cross-stack subnet references embed the construct name in the Fn::ImportValue key,
        // e.g. "LvNetworkStack:ExportsOutputRefVpcpublicSubnet1Subnet2BB74..."
        for (const sk of subnetKeys) {
            const lower = sk.constructName.toLowerCase()
            if (json.toLowerCase().includes(lower)) {
                return sk.type
            }
        }
        // Check for props that imply VPC membership but no specific subnet
        // "subnet" catches subnetId, SubnetGroup, subnets[], vpcSubnetIds — triggers subtree search
        const lower = json.toLowerCase()
        if (lower.includes('vpcid') || lower.includes('"vpc"') || lower.includes('subnet')) {
            return 'VPC'
        }
        // No VPC references at all → external AWS service (Secrets Manager, CloudWatch, SNS, SSM, etc.)
        return 'EXTERNAL'
    }

    // ── 4. Network outputs collection ─────────────────────────────────────────

    private collectNetworkOutputsFromTemplates(
        cdkOutPath: string,
        includedStacks: string[],
    ): NetworkOutput[] {
        const fs = require('fs')
        const path = require('path')
        const outputs: NetworkOutput[] = []
        const cidrPattern = /cidr|ip|subnet|network|vpcid/i

        // First, build a map of resource logical IDs to their actual CIDR values from tree.json
        const treeJsonPath = path.join(cdkOutPath, 'tree.json')
        const cidrMap = new Map<string, string>()

        try {
            if (fs.existsSync(treeJsonPath)) {
                const treeContent = fs.readFileSync(treeJsonPath, 'utf-8')
                const tree = JSON.parse(treeContent)
                this.extractCidrValuesFromTree(tree.tree, cidrMap)
            }
        } catch (err) {
            // Continue without CIDR resolution if tree.json can't be read
        }

        for (const stackName of includedStacks) {
            const templatePath = path.join(cdkOutPath, `${stackName}.template.json`)

            try {
                if (!fs.existsSync(templatePath)) continue

                const templateContent = fs.readFileSync(templatePath, 'utf-8')
                const template = JSON.parse(templateContent)

                if (!template.Outputs) continue

                // Process each output in the CloudFormation template
                for (const [, outputDef] of Object.entries(template.Outputs)) {
                    const output = outputDef as any

                    // Check if the output has an export name that matches network patterns
                    const exportName = output.Export?.Name
                    if (!exportName || typeof exportName !== 'string') continue
                    if (!cidrPattern.test(exportName)) continue

                    // Extract the value and resolve it to actual CIDR/ID if possible
                    let displayValue: string
                    let isVpcId = false
                    const value = output.Value

                    if (typeof value === 'string') {
                        displayValue = value
                    } else if (value && typeof value === 'object') {
                        // Try to resolve CloudFormation references to actual values
                        if (value.Ref) {
                            // Check if this is a VPC ID reference
                            if (value.Ref.startsWith('Vpc') && !value.Ref.includes('Subnet')) {
                                isVpcId = true
                                displayValue = `\${${value.Ref}}`  // Don't resolve VPC IDs from CIDR map
                            } else {
                                // For subnets, resolve to CIDR if available
                                const resolved = cidrMap.get(value.Ref)
                                displayValue = resolved || `\${${value.Ref}}`
                            }
                        } else if (value['Fn::GetAtt']) {
                            const getAtt = value['Fn::GetAtt']
                            if (Array.isArray(getAtt) && getAtt.length === 2) {
                                // For GetAtt, resolve from cidrMap (this gets CIDRs)
                                const resolved = cidrMap.get(getAtt[0])
                                displayValue = resolved || `\${${getAtt[0]}.${getAtt[1]}}`
                            } else {
                                displayValue = JSON.stringify(value)
                            }
                        } else {
                            displayValue = JSON.stringify(value)
                        }
                    } else {
                        displayValue = String(value)
                    }

                    // Determine the label based on the export name and value type
                    let name: string
                    if (exportName.toLowerCase().includes('vpcid') || isVpcId) {
                        // Skip VPC ID - we can't get the actual AWS Console VPC ID from CDK synth
                        // The actual VPC ID (vpc-xxx) is only available after deployment
                        continue
                    } else if (!displayValue.includes('/') && displayValue.startsWith('${')) {
                        // Skip unresolved non-CIDR references (bare subnet IDs without CIDR)
                        continue
                    } else {
                        // This is a CIDR block
                        name = this.humanizeOutputName(exportName, stackName)
                    }

                    outputs.push({ name, value: displayValue })
                }
            } catch (err) {
                // Silently skip stacks that don't have readable templates
                continue
            }
        }

        return outputs.sort((a, b) => a.name.localeCompare(b.name))
    }

    // Recursively walk the CDK tree and extract CIDR values from resource props
    private extractCidrValuesFromTree(node: any, cidrMap: Map<string, string>): void {
        if (!node) return

        // Check if this node has CloudFormation properties with a cidrBlock
        if (node.attributes) {
            const logicalId = node.attributes['aws:cdk:cloudformation:logicalId']
            const props = node.attributes['aws:cdk:cloudformation:props']

            if (logicalId && props && props.cidrBlock) {
                cidrMap.set(logicalId, props.cidrBlock)
            }
        }

        // Recurse into children
        if (node.children) {
            for (const childKey in node.children) {
                this.extractCidrValuesFromTree(node.children[childKey], cidrMap)
            }
        }
    }

    // Convert export name to human-readable label
    // e.g. "LvNetworkStack:ExportsOutputRefVpcpublicSubnet1Subnet2BB74ED7" → "Public Subnet 1"
    private humanizeOutputName(exportName: string, stackName: string): string {
        // Remove stack name prefix if present
        let name = exportName.replace(new RegExp(`^${stackName}:?`, 'i'), '')

        // Remove CDK export patterns: ExportsOutput, Ref, FnGetAtt
        name = name.replace(/^ExportsOutput/i, '')
        name = name.replace(/^Ref/i, '')
        name = name.replace(/^FnGetAtt/i, '')

        // Remove "Vpc" prefix and resource hash suffix
        name = name.replace(/^Vpc/i, '')
        name = name.replace(/[A-Z0-9]{8,}$/, '')  // Remove hash suffix like "2BB74ED7"

        // Remove trailing "Subnet" or "CidrBlock" that appears after the meaningful part
        name = name.replace(/Subnet$/i, '')
        name = name.replace(/CidrBlock$/i, '')

        // Now handle specific patterns
        if (!name || name.toLowerCase() === 'cidrblock' || name === '') {
            return 'VPC'
        }

        // Handle subnet patterns: "publicSubnet1" → "Public Subnet 1"
        // Extract subnet type and number
        const subnetMatch = name.match(/^(public|private|isolated)Subnet(\d+)/i)
        if (subnetMatch) {
            const type = subnetMatch[1].charAt(0).toUpperCase() + subnetMatch[1].slice(1).toLowerCase()
            const num = subnetMatch[2]
            return `${type} Subnet ${num}`
        }

        // Fallback: general humanization
        name = name
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .trim()

        return name || exportName
    }

    // ── 5. Edge resolution ────────────────────────────────────────────────────

    private resolveEdges(
        appNode: cdk.Node,
        includedStacks: string[],
        resources: TopologyResource[],
    ): TopologyEdge[] {
        const edges: TopologyEdge[] = []
        const resourceMap = new Map(resources.map(r => [r.id, r]))

        // Pre-compute hidden-resource props for each stack.  When detecting edges FROM a visible
        // resource we also search through all hidden sibling resources in the same stack (e.g. the
        // task definition that holds environment variables pointing at Redis/DB Proxy, or the NLB
        // listener that references the load balancer ARN via Fn::ImportValue).
        const stackHiddenJson = new Map<string, string>()
        for (const stackName of includedStacks) {
            const stackNode = appNode.children.get(stackName)
            if (!stackNode) continue
            const hiddenPropsArr: Record<string, unknown>[] = []
            this.collectHiddenResourceProps(stackNode, hiddenPropsArr)
            stackHiddenJson.set(stackName, JSON.stringify(hiddenPropsArr))
        }

        // Walk all included stacks and look for CFN prop cross-references
        appNode.children.forEach(stackNode => {
            if (!includedStacks.includes(stackNode.id)) return
            this.findEdgesInNode(stackNode, resources, resourceMap, edges, stackHiddenJson)
        })

        // Architectural rule: ECS Service → RDS DB Proxy.
        // The application connects to the proxy at runtime (credentials via SSM/Secrets), so there
        // is no CDK import-value chain to trace.  Add the edge whenever both types coexist.
        const ecsServices = resources.filter(r => r.cfnType === 'AWS::ECS::Service')
        const dbProxies   = resources.filter(r => r.cfnType === 'AWS::RDS::DBProxy')
        for (const svc of ecsServices) {
            for (const proxy of dbProxies) {
                edges.push({ fromId: svc.id, toId: proxy.id, dashed: svc.placement !== proxy.placement })
            }
        }

        // Deduplicate exact duplicates first
        const seen = new Set<string>()
        const deduped = edges.filter(e => {
            const key = `${e.fromId}→${e.toId}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })

        // Then collapse bidirectional pairs: if A→B and B→A both exist, keep only the one where
        // the source is "shallower" in the VPC hierarchy (PUBLIC < PRIVATE < ISOLATED < EXTERNAL).
        // This preserves correct traffic-flow direction (e.g. DbProxy→Database, NLB→Service).
        const pairBest = new Map<string, TopologyEdge>()
        for (const e of deduped) {
            const pair = [e.fromId, e.toId].sort().join('↔')
            if (!pairBest.has(pair)) {
                pairBest.set(pair, e)
            } else {
                const existing = pairBest.get(pair)!
                const fromDepth    = PLACEMENT_DEPTH[resourceMap.get(e.fromId)?.placement ?? ''] ?? 5
                const existDepth   = PLACEMENT_DEPTH[resourceMap.get(existing.fromId)?.placement ?? ''] ?? 5
                if (fromDepth < existDepth) pairBest.set(pair, e)
            }
        }
        return [...pairBest.values()]
    }

    // Collect props from hidden resources whose types are in EDGE_DETECTION_HIDDEN_TYPES.
    // Uses a strict whitelist rather than the full TOPOLOGY_HIDDEN_TYPES set to avoid collecting
    // SecurityGroupIngress / route table entries that contain cross-stack security-group refs
    // and produce false-positive edges.
    private collectHiddenResourceProps(node: cdk.Node, result: Record<string, unknown>[]): void {
        for (const [, child] of node.children) {
            const cfnType = this.getCfnType(child)
            const resourceChild = child.children.get('Resource')
            const effectiveCfnType = cfnType ?? (resourceChild ? this.getCfnType(resourceChild) : null)
            if (effectiveCfnType && EDGE_DETECTION_HIDDEN_TYPES.has(effectiveCfnType)) {
                const effectiveNode = cfnType ? child : (resourceChild ?? child)
                const props = this.getCfnProps(effectiveNode)
                if (Object.keys(props).length > 0) result.push(props)
            }
            this.collectHiddenResourceProps(child, result)
        }
    }

    private findEdgesInNode(
        node: cdk.Node,
        resources: TopologyResource[],
        resourceMap: Map<string, TopologyResource>,
        edges: TopologyEdge[],
        stackHiddenJson: Map<string, string>,
    ): void {
        const nodeId = this.sanitizeId(node.path)
        const fromRes = resourceMap.get(nodeId)

        if (fromRes) {
            const effectiveNode = node.children.get('Resource') ?? node
            const ownProps = this.getCfnProps(effectiveNode)
            const ownJson = JSON.stringify(ownProps)

            // Expand edge search to include all hidden sibling resources in the same stack.
            // This surfaces connections that flow through hidden CDK constructs such as:
            //   - NlbListener (references the NLB ARN via Fn::ImportValue)
            //   - TaskDefinition (holds env vars pointing at Redis endpoint, DB Proxy, etc.)
            const stackName = nodeId.replace(/^node_/, '').split('_')[0]
            const hiddenJson = stackHiddenJson.get(stackName) ?? ''
            const expandedJson = ownJson + hiddenJson

            for (const target of resources) {
                if (target.id === nodeId) continue
                // Skip networking infrastructure as edge endpoints — they create too many
                // false-positive matches because their path parts appear in every cross-stack ref
                if (EDGE_EXCLUDED_TYPES.has(fromRes.cfnType) || EDGE_EXCLUDED_TYPES.has(target.cfnType)) continue
                // Skip IAM Role → IAM Role edges (trust policy cross-references create false positives)
                if (fromRes.cfnType === 'AWS::IAM::Role' && target.cfnType === 'AWS::IAM::Role') continue
                // Match by partial construct path: target's path parts (excluding stack names)
                // appear in the expanded props JSON as CFN logical ID fragments.
                // For IAM Roles, use length >= 7 to include "IAMRole" but exclude generic "Role".
                const minPartLength = target.cfnType === 'AWS::IAM::Role' ? 7 : 3
                const targetPathParts = target.id
                    .replace(/^node_/, '').split('_')
                    .filter(p => p.length >= minPartLength && !p.endsWith('Stack') && !p.endsWith('stack'))
                const ownMatchCount = targetPathParts.filter(part => ownJson.includes(part)).length
                const expandedMatchCount = targetPathParts.filter(part => expandedJson.includes(part)).length
                const matchesInOwn = target.cfnType === 'AWS::IAM::Role' ? ownMatchCount >= 2 : ownMatchCount >= 1
                const matchesInExpanded = target.cfnType === 'AWS::IAM::Role' ? expandedMatchCount >= 2 : expandedMatchCount >= 1

                // For Load Balancer targets: allow expanded matches only for ECS Services (the NLB is
                // referenced via hidden NlbListener). For other sources, use own-props-only to avoid
                // false IAM Role → NLB edges.
                const isLbTarget = target.cfnType === 'AWS::ElasticLoadBalancingV2::LoadBalancer'
                const isEcsService = fromRes.cfnType === 'AWS::ECS::Service'
                const matches = (isLbTarget && !isEcsService) ? matchesInOwn : matchesInExpanded

                if (matches) {
                    // Edge direction rules:
                    // - Load balancers: traffic flows FROM LB TO service (flip the reference direction)
                    // - IAM Roles: edge FROM owning resource TO role (standard reference direction)
                    const isLbTarget = target.cfnType === 'AWS::ElasticLoadBalancingV2::LoadBalancer'
                    const isRoleTarget = target.cfnType === 'AWS::IAM::Role'

                    let edgeFrom: string
                    let edgeTo: string
                    if (isLbTarget) {
                        // LB referenced by service → traffic flows LB → service
                        edgeFrom = target.id
                        edgeTo = nodeId
                    } else if (isRoleTarget) {
                        // Role referenced by resource → show resource → role ownership
                        edgeFrom = nodeId
                        edgeTo = target.id
                    } else {
                        // Standard: source references target → source → target
                        edgeFrom = nodeId
                        edgeTo = target.id
                    }

                    edges.push({
                        fromId: edgeFrom,
                        toId: edgeTo,
                        dashed: fromRes.placement !== target.placement,
                    })
                }
            }
            return
        }

        node.children.forEach(child => {
            this.findEdgesInNode(child, resources, resourceMap, edges, stackHiddenJson)
        })
    }

    // ── 6. DOT generation ─────────────────────────────────────────────────────

    private renderDot(
        resources: TopologyResource[],
        edges: TopologyEdge[],
        networkOutputs: NetworkOutput[],
        theme: CdkDiaTheme,
    ): RootGraphModel {
        const graph = digraph('Topology')
        const fontName = theme.fontName ?? 'Sans-Serif'
        const edgeColor = theme.primaryColor ? `${theme.primaryColor}CC` : '#D58714CC'

        graph.set('compound', true)
        graph.set('pad', 1.5)
        graph.set('nodesep', 0.75)     // Horizontal spacing between nodes
        graph.set('ranksep', 0.7)      // Vertical spacing between ranks - more compact
        graph.set('fontname', fontName)
        graph.set('fontsize', 14)
        graph.set('dpi', 200)
        graph.set('rankdir', 'TB')
        graph.set('splines', 'ortho')
        graph.set('newrank', true)  // Enable more flexible ranking

        graph.attributes.node.set('shape', 'box')
        graph.attributes.node.set('style', 'rounded')
        graph.attributes.node.set('fixedsize', true)
        graph.attributes.node.set('width', 1.6)
        graph.attributes.node.set('height', 1.6)
        graph.attributes.node.set('fontname', fontName)
        graph.attributes.node.set('fontsize', 10)

        graph.attributes.edge.set('color', edgeColor as any)
        graph.attributes.edge.set('penwidth', 1.5)
        graph.attributes.edge.set('arrowhead', 'normal')
        graph.attributes.edge.set('arrowtail', 'none')
        graph.attributes.edge.set('dir', 'forward')

        // AWS Cloud outer boundary
        const awsCloud = graph.createSubgraph('cluster_aws')
        awsCloud.attributes.graph.set('label', 'AWS Cloud')
        awsCloud.attributes.graph.set('style', 'dashed,rounded')
        awsCloud.attributes.graph.set('color', '#232F3E')
        awsCloud.attributes.graph.set('fillcolor', '#F8F9FA')
        awsCloud.attributes.graph.set('fontsize', 18)
        awsCloud.attributes.graph.set('fontcolor', '#232F3E')
        awsCloud.attributes.graph.set('penwidth', 2)
        awsCloud.attributes.graph.set('margin', 24)
        awsCloud.attributes.graph.set('labeljust', 'l')
        awsCloud.attributes.graph.set('labelloc', 't')

        // VPC boundary (inside AWS Cloud)
        const vpcCluster = awsCloud.createSubgraph('cluster_vpc')
        vpcCluster.attributes.graph.set('label', 'VPC')
        vpcCluster.attributes.graph.set('style', 'filled,rounded')
        vpcCluster.attributes.graph.set('fillcolor', '#F0FFF4')
        vpcCluster.attributes.graph.set('color', '#2E7D32')
        vpcCluster.attributes.graph.set('penwidth', 2)
        vpcCluster.attributes.graph.set('fontsize', 16)
        vpcCluster.attributes.graph.set('fontcolor', '#2E7D32')
        vpcCluster.attributes.graph.set('margin', 16)
        vpcCluster.attributes.graph.set('labeljust', 'l')
        vpcCluster.attributes.graph.set('labelloc', 't')

        // Create subnet zone clusters (only for zones that have resources)
        const zoneSubgraphs = new Map<SubnetType, SubgraphModel>()
        for (const zone of ['PUBLIC', 'PRIVATE', 'ISOLATED'] as SubnetType[]) {
            if (!resources.some(r => r.placement === zone)) continue
            const style = ZONE_STYLE[zone]
            const sg = vpcCluster.createSubgraph(`cluster_zone_${zone.toLowerCase()}`)
            sg.attributes.graph.set('label', style.label)
            sg.attributes.graph.set('style', 'filled,rounded')
            sg.attributes.graph.set('fillcolor', style.fill)
            sg.attributes.graph.set('color', style.pen)
            sg.attributes.graph.set('penwidth', 1.5)
            sg.attributes.graph.set('fontsize', 13)
            sg.attributes.graph.set('fontcolor', style.pen as any)
            sg.attributes.graph.set('margin', 12)
            sg.attributes.graph.set('labeljust', 'l')
            sg.attributes.graph.set('labelloc', 't')
            zoneSubgraphs.set(zone, sg)
        }

        // Create ECS Cluster subgraphs (inside the appropriate zone subgraph)
        const ecsClusterSubgraphs = new Map<string, SubgraphModel>()
        for (const res of resources) {
            if (res.cfnType !== 'AWS::ECS::Cluster') continue
            let parentContainer: SubgraphModel
            if (res.placement === 'PUBLIC' || res.placement === 'PRIVATE' || res.placement === 'ISOLATED') {
                parentContainer = zoneSubgraphs.get(res.placement) ?? vpcCluster
            } else {
                parentContainer = vpcCluster
            }
            const clusterSg = parentContainer.createSubgraph(`cluster_ecs_${res.id}`)
            clusterSg.attributes.graph.set('label', 'ECS Cluster')
            clusterSg.attributes.graph.set('style', 'filled,rounded')
            clusterSg.attributes.graph.set('fillcolor', '#FFF8E1')
            clusterSg.attributes.graph.set('color', '#FF8F00')
            clusterSg.attributes.graph.set('penwidth', 1.5)
            clusterSg.attributes.graph.set('fontsize', 11)
            clusterSg.attributes.graph.set('fontcolor', '#E65100')
            clusterSg.attributes.graph.set('margin', 10)
            clusterSg.attributes.graph.set('labeljust', 'l')
            clusterSg.attributes.graph.set('labelloc', 't')
            ecsClusterSubgraphs.set(res.id, clusterSg)
        }

        // Place each resource into its container (ECS Cluster subgraph, zone, vpc, or external)
        for (const res of resources) {
            if (res.cfnType === 'AWS::ECS::Cluster') continue  // rendered as subgraph, not a node

            let container: SubgraphModel
            if (res.ecsClusterId && ecsClusterSubgraphs.has(res.ecsClusterId)) {
                container = ecsClusterSubgraphs.get(res.ecsClusterId)!
            } else if (res.placement === 'PUBLIC' || res.placement === 'PRIVATE' || res.placement === 'ISOLATED') {
                container = zoneSubgraphs.get(res.placement) ?? vpcCluster
            } else if (res.placement === 'VPC') {
                container = vpcCluster
            } else {
                container = awsCloud  // EXTERNAL
            }
            this.addNode(container, res, fontName)
        }

        // Chain IAM roles vertically with invisible edges to keep them stacked
        const iamRoles = resources.filter(r => r.cfnType === 'AWS::IAM::Role')
        iamRoles.sort((a, b) => a.label.localeCompare(b.label))

        for (let i = 0; i < iamRoles.length - 1; i++) {
            graph.createEdge([iamRoles[i].id, iamRoles[i + 1].id], {
                style: 'invis',
                weight: 1000,
            })
        }

        // Add network information box if we have outputs (before edges)
        let legendNodeId: string | null = null
        if (networkOutputs.length > 0) {
            legendNodeId = this.addNetworkInfoBox(graph, networkOutputs, fontName)
        }

        // Add edges — exclude ECS Cluster resources since they are subgraphs, not nodes
        const nodeIds = new Set(
            resources.filter(r => r.cfnType !== 'AWS::ECS::Cluster').map(r => r.id)
        )
        for (const edge of edges) {
            if (!nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId)) continue
            graph.createEdge([edge.fromId, edge.toId], {
                style: edge.dashed ? 'dashed' : 'solid',
            })
        }

        // Force legend to appear centered at bottom below AWS Cloud
        if (legendNodeId) {
            // Create a subgraph to group the legend at the bottom
            const legendGroup = graph.createSubgraph('legend_positioning')
            legendGroup.attributes.graph.set('rank', 'sink')
            legendGroup.attributes.graph.set('style', 'invis')

            // Move the legend node into this subgraph by creating it there
            // (Note: the node was already created, this creates positioning constraint)

            // Connect from multiple nodes across the diagram to center it
            if (nodeIds.size > 0) {
                const nodes = Array.from(nodeIds)
                const connections = Math.min(5, nodes.length)
                for (let i = 0; i < connections; i++) {
                    const nodeIdx = Math.floor(i * nodes.length / connections)
                    graph.createEdge([nodes[nodeIdx], legendNodeId], {
                        style: 'invis',
                        weight: 1,
                        minlen: 3,
                    })
                }
            }
        }

        return graph
    }

    private addNetworkInfoBox(
        graph: RootGraphModel,
        networkOutputs: NetworkOutput[],
        fontName: string,
    ): string {
        // Create a vertical list with a border table to look like a map legend
        const rows = networkOutputs.map(output => {
            // Escape special characters for HTML label
            const name = output.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            const value = output.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            // Truncate long values to prevent overflow
            const displayValue = value.length > 50 ? value.substring(0, 47) + '...' : value
            return `<tr><td align="left" border="0"><font point-size="9"><b>${name}:</b></font></td><td align="left" border="0"><font point-size="9">${displayValue}</font></td></tr>`
        }).join('\n')

        // Use an HTML table with borders to create a clear legend box
        const label = `<<table border="1" cellborder="0" cellspacing="0" cellpadding="6" bgcolor="#FFFFFF" color="#333333">
<tr><td colspan="2" align="center" bgcolor="#E8E8E8" border="0"><b><font point-size="11">NETWORK INFORMATION</font></b></td></tr>
${rows}
</table>>`

        // Create the legend node directly in the graph
        const nodeId = 'network_info_legend'
        const node = graph.createNode(nodeId)
        node.attributes.set('label', label as any)
        node.attributes.set('shape', 'plaintext')  // Use plaintext to rely on HTML table borders
        node.attributes.set('fontname', fontName)
        // Don't set fixedsize, let it auto-size to content
        node.attributes.set('width', 0)
        node.attributes.set('height', 0)

        return nodeId
    }

    private addNode(container: SubgraphModel, res: TopologyResource, fontName: string): void {
        const node = container.createNode(res.id)
        const labelLines = res.label.split('\n')
        node.attributes.set('label', res.label)
        node.attributes.set('fontname', fontName)
        node.attributes.set('fontsize', 10)

        // Set group attribute for IAM roles to force vertical alignment
        if (res.cfnType === 'AWS::IAM::Role') {
            node.attributes.set('group', 'iam_roles')
        }

        if (res.icon?.path) {
            const isSmaller = res.icon.format === ComponentIconFormat.SMALLER
            const base = isSmaller ? 1.2 : 1.5
            node.attributes.set('image', res.icon.path)
            node.attributes.set('imagescale', true)
            node.attributes.set('imagepos', 'tc')
            node.attributes.set('labelloc', 'b')
            node.attributes.set('penwidth', 0)
            node.attributes.set('shape', 'none')
            node.attributes.set('fixedsize', true)
            node.attributes.set('width', base)
            node.attributes.set('height', base + 0.2 + labelLines.length * 0.18)
        } else {
            node.attributes.set('shape', 'box')
            node.attributes.set('style', 'rounded,filled')
            node.attributes.set('fillcolor', '#FFFFFF' as any)
            node.attributes.set('width', 1.6)
            node.attributes.set('height', 0.8)
        }
    }
}
