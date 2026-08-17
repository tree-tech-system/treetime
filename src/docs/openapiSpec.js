const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'TreeTime API',
      version: '1.0.0',
      description:
        'API לניהול ודיווח שעות עבודה של TreeTime. תומך בהתחברות משתמשים (JWT) ובאינטגרציות שרת-לשרת (API Key). ' +
        'ראו את מדריך השילוב המלא ב-/api/guide.',
    },
    servers: [{ url: '/', description: 'Current server' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'טוקן שמתקבל מ- /api/auth/login, לשימוש משתמשי קצה (אפליקציית ווב/מובייל).',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'מפתח API קבוע לשימוש אינטגרציות שרת-לשרת. נוצר דרך /api/api-keys (admin בלבד).',
        },
      },
    },
  },
  apis: [path.join(__dirname, '../routes/*.js')],
});

module.exports = spec;
