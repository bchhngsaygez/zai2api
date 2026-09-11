import express from 'express';
import { config } from '../../config.js';

export const modelsRouter = express.Router();

const availableModels = [
  {
    id: 'glm-5.3-flash',
    object: 'model',
    created: 1700000000,
    owned_by: 'z.ai',
    permission: [],
    root: 'glm-5.3-flash',
    parent: null,
  },
  {
    id: 'glm-5.3',
    object: 'model',
    created: 1700000000,
    owned_by: 'z.ai',
    permission: [],
    root: 'glm-5.3',
    parent: null,
  },
  {
    id: 'glm-5.2',
    object: 'model',
    created: 1700000000,
    owned_by: 'z.ai',
    permission: [],
    root: 'glm-5.2',
    parent: null,
  },
];

modelsRouter.get(['/v1/models', '/models'], (req, res) => {
  res.json({
    object: 'list',
    data: availableModels,
  });
});

modelsRouter.get(['/v1/models/:model', '/models/:model'], (req, res) => {
  const model = availableModels.find(m => m.id === req.params.model);
  if (!model) {
    return res.status(404).json({
      error: {
        message: `Model '${req.params.model}' not found`,
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    });
  }
  res.json(model);
});
