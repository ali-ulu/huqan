'use strict';

function assertPilotTestDatabaseBoundary(environment) {
  const required = ['HUQAN_ENVIRONMENT', 'HUQAN_TEST_DB_NAME', 'HUQAN_TEST_DB_USER', 'HUQAN_TEST_DB_SERVER', 'HUQAN_TEST_DB_MARKER'];
  for (const key of required) {
    if (typeof environment[key] !== 'string' || environment[key].trim() === '') throw new Error(`missing_test_database_setting:${key}`);
  }
  if (environment.HUQAN_ENVIRONMENT !== 'test' || environment.HUQAN_TEST_DB_MARKER !== 'huqan-pilot-test-only') {
    throw new Error('test_database_environment_invalid');
  }
  const identities = [environment.HUQAN_TEST_DB_NAME, environment.HUQAN_TEST_DB_USER, environment.HUQAN_TEST_DB_SERVER]
    .map((value) => value.toLowerCase());
  if (identities.some((value) => !value.includes('test')
    || /(?:^|[._-])(prod|production)(?:$|[._-])/.test(value))) {
    throw new Error('production_database_forbidden');
  }
  for (const forbidden of ['DATABASE_URL', 'DB_NAME', 'DB_USER', 'DB_SERVER']) {
    if (environment[forbidden]) throw new Error(`production_database_credential_present:${forbidden}`);
  }
  return Object.freeze({
    environment: 'test',
    database: environment.HUQAN_TEST_DB_NAME,
    user: environment.HUQAN_TEST_DB_USER,
    server: environment.HUQAN_TEST_DB_SERVER,
  });
}

module.exports = { assertPilotTestDatabaseBoundary };
