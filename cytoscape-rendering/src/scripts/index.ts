import * as cytoscape from 'cytoscape';
import '../styles/index.scss';

cytoscape.use(require('cytoscape-elk'));

const initCytoscape =   async () => {
    try {
        console.log('Loading diagram data...');

        const elementsResponse = await fetch('cy-elements.json');
        if (!elementsResponse.ok) {
            throw new Error(`Failed to load cy-elements.json: ${elementsResponse.status} ${elementsResponse.statusText}`);
        }

        const stylesResponse = await fetch('cy-styles.json');
        if (!stylesResponse.ok) {
            throw new Error(`Failed to load cy-styles.json: ${stylesResponse.status} ${stylesResponse.statusText}`);
        }

        const elements = await elementsResponse.json();
        const styles = await stylesResponse.json();

        console.log(`Loaded ${elements.length} elements`);

        const cy: cytoscape.Core = cytoscape({
            container: document.getElementById('cy'), // container to render in
            elements: elements,
            style: styles,
            layout: {
                name: 'elk',
                // @ts-ignore
                nodeDimensionsIncludeLabels: true, // Boolean which changes whether label dimensions are included when calculating node dimensions
                fit: true, // Whether to fit
                padding: 30, // Padding on fit
                // @ts-ignore
                priority: () => undefined,
                // @ts-ignore
                elk: {
                    'algorithm': 'layered', // best found: rectpacking, layered, box
                    // supported options for algorithm:layered https://www.eclipse.org/elk/reference/algorithms/org-eclipse-elk-layered.html
                    'elk.direction': 'UNDEFINED',
                    'elk.layered.wrapping.additionalEdgeSpacing': 30,
                    'elk.alignment': 'UNDEFINED',
                    'elk.layered.spacing.nodeNodeBetweenLayers': 50, // default: 20
                    'elk.layered.spacing.edgeEdgeBetweenLayers': 50, // default: 10
                    'elk.layered.considerModelOrder.strategy': 'NONE', // NONE / NODES_AND_EDGES / PREFER_EDGES, default: NONE
                }
            }
        });
        cy.resize();
        cy.zoom(1);
        cy.center();

        console.log('Diagram initialized successfully');
    } catch (error) {
        console.error('Failed to initialize diagram:', error);
        const container = document.getElementById('cy');
        if (container) {
            container.innerHTML = `
                <div style="padding: 20px; color: #d32f2f; font-family: monospace;">
                    <h2>Failed to load diagram</h2>
                    <pre>${error}</pre>
                    <p>Check the browser console for more details.</p>
                </div>
            `;
        }
    }
}

initCytoscape()