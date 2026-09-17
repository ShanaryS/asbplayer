module.exports = {
    preset: 'ts-jest/presets/default-esm',
    extensionsToTreatAsEsm: ['.ts'],
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', useESM: true }],
    },
};
