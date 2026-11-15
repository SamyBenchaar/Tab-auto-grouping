// JSON Schema of the model answer, sent as `responseJsonSchema` (Gemini structured output).
import { TAB_GROUP_COLORS } from './constants.js';

export function buildResponseSchema() {
  return {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        description: 'Groupes de contexte (nouveaux ou existants réutilisés).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nom court du groupe (1 à 3 mots), sans emoji.' },
            emoji: { type: 'string', description: 'Un seul emoji représentatif du contexte.' },
            color: { type: 'string', enum: [...TAB_GROUP_COLORS] },
            existingGroupId: {
              type: ['integer', 'null'],
              description: "Id d'un groupe existant réutilisé, sinon null.",
            },
            tabIds: {
              type: 'array',
              description: 'Ids des onglets du groupe.',
              items: { type: 'integer' },
            },
          },
          required: ['name', 'emoji', 'color', 'existingGroupId', 'tabIds'],
        },
      },
      ungrouped: {
        type: 'array',
        description: "Ids des onglets qui ne vont dans aucun groupe.",
        items: { type: 'integer' },
      },
    },
    required: ['groups', 'ungrouped'],
  };
}
