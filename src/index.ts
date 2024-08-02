import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { argv } from 'node:process';
import generator from '@babel/generator';
import parser from '@babel/parser';
import traverse from '@babel/traverse';
import t from '@babel/types';
import glob from 'fast-glob';
import { format } from 'prettier';

async function main() {
	const misskeyPath: string | undefined = argv[2];
	if (misskeyPath == null) {
		throw new Error('Please specify Misskey path.');
	}

	const modelsPath = path.join(misskeyPath, 'packages/backend/src/models/json-schema');

	const modelFiles = await fs.promises.readdir(modelsPath);
	for await (const file of modelFiles) {
		convertSchema(path.join(modelsPath, file));
	}

	const endpointsPath = path.join(misskeyPath, 'packages/backend/src/server/api/endpoints/**/*(?!.test).ts');
	const endpointFiles = await glob(endpointsPath);
	for await (const file of endpointFiles) {
		convertSchema(file);
	}
}

async function convertSchema(filePath: string) {
	const code = fs.readFileSync(filePath).toString();
	const ast = parser.parse(code, {
		sourceType: 'module',
		plugins: ['typescript', 'decorators-legacy'],
	});

	traverse.default(ast, {
		ObjectExpression(path) {
			const parentType = path.parent.type;

			const requiredFields: string[] = [];
			const schema = path.get('properties');
			const schemaProps = schema.filter(p => p.isObjectProperty());

			const typeNode = schemaProps.find(p => p.get('key').isIdentifier({ name: 'type' }))?.get('value').node;
			let type: string | undefined;
			if (typeNode != null) {
				if (typeNode.type == 'StringLiteral') {
					type = typeNode.value;
				}
			}

			for (const schemaProp of schemaProps) {
				const schemaPropValue = schemaProp.get('value');

				if (schemaPropValue.isObjectExpression()) {
					const valueProps = schemaPropValue.get('properties').filter(p => p.isObjectProperty());

					for (const valueProp of valueProps) {
						if (valueProp.get('key').isIdentifier({ name: 'optional' })) {
							if (type !== 'array' && valueProp.get('value').isBooleanLiteral({ value: false })) {
								const node = schemaProp.get('key').node;
								assert(node.type === 'Identifier');
								requiredFields.push(node.name);
							}

							if (parentType === 'TSAsExpression') {
								console.warn(`skip: ${filePath}`);
							} else {
								valueProp.remove();
							}
						}
					}
				}
			}

			if (requiredFields.length > 0) {
				path.node.properties.push(
					t.objectProperty(
						t.identifier('required'),
						t.arrayExpression(requiredFields.map(field => t.stringLiteral(field))),
					),
				);
			}
		},
	});

	const output = await format(
		generator.default(ast).code,
		{
			parser: 'babel-ts',
			singleQuote: true,
			useTabs: true,
		},
	);

	fs.writeFileSync(filePath, output);
}

main();
