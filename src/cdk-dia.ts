import * as cdk from "../src/cdk"
import * as path from "path"
import * as diagrams from "../src/diagram"
import * as graphviz from "../src/render/graphviz"
import * as cytoscape from "../src/render/cytoscape"
import {CdkDiaTheme} from "../src/brand/theme"
import {AwsTopologyGenerator} from "../src/render/graphviz/aws-topology-generator"

export enum Renderers {
    GRAPHVIZ='graphviz-png',
    CYTOSCAPE='cytoscape-html',
    ARCHITECTURE='architecture-png', // reserved for future polished renderer
}

export class CdkDia {

    private applyHideComponents(node: diagrams.Component, patterns: string[]): void {
        const toRemove: diagrams.Component[] = []
        node.subComponents().forEach(sub => {
            const label = sub.label.join(' ')
            const matches = patterns.some(p => label === p || label.includes(p))
            if (matches) {
                toRemove.push(sub)
            } else {
                this.applyHideComponents(sub, patterns)
            }
        })
        toRemove.forEach(sub => {
            sub.removeAndDestroyAllSubComponents()
            node.removeSubComponent(sub)
        })
    }

    async generateDiagram(treeJsonPath: string,
                          targetPath: string,
                          collapse: boolean,
                          collapseDoubleClusters: boolean,
                          cdkBasePath: string = require.resolve('@skyionblue/cdk-dia/package.json'),
                          includedStacks: string[] | false = false,
                          excludedStacks: string[] | undefined = undefined,
                          renderer: Renderers,
                          theme?: CdkDiaTheme) {

        // Parse tree.json
        const cdkTree = cdk.TreeJsonLoader.load(path.isAbsolute(treeJsonPath) ? treeJsonPath : path.join(process.cwd(), treeJsonPath))

        // Topology mode — bypass the CDK-stack-hierarchy diagram entirely
        if (theme?.topology && renderer === Renderers.GRAPHVIZ) {
            const stacks = includedStacks === false
                ? Array.from(cdkTree.tree.children.keys()).filter(k => k !== 'Tree')
                : includedStacks
            const topologyGenerator = new AwsTopologyGenerator(new diagrams.AwsIconSupplier(`${cdkBasePath}`))
            // Derive cdk.out path from tree.json path
            const cdkOutPath = path.dirname(treeJsonPath)
            const graphModel = topologyGenerator.generate(cdkTree, stacks, theme, cdkOutPath)
            return graphviz.Graphviz.renderGraphModel(graphModel, targetPath, theme)
        }

        // Generate Diagram
        const generator = new diagrams.AwsDiagramGenerator(new diagrams.AwsEdgeResolver(), new diagrams.AwsIconSupplier(`${cdkBasePath}`))
        const diagram = generator.generate(cdkTree, collapse, collapseDoubleClusters, includedStacks, excludedStacks ?? undefined)

        // Remove components matching theme hideComponents patterns
        if (theme?.hideComponents && theme.hideComponents.length > 0) {
            this.applyHideComponents(diagram.root, theme.hideComponents)
        }

        // Render diagram
        switch (renderer) {
            case Renderers.GRAPHVIZ:
                return new graphviz.Graphviz().render({
                    diagram: diagram,
                    path: `${targetPath}`,
                    theme,
                })
            case Renderers.CYTOSCAPE:
                return new cytoscape.Cytoscape().render({
                    diagram: diagram,
                    path: `${targetPath}`,
                    theme,
                })
            case Renderers.ARCHITECTURE:
                throw new Error('The architecture renderer is not yet implemented.')
            default:
                throw Error(`Unknown renderer: ${renderer}`)
        }
    }
}
