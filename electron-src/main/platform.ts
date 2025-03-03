

// export const currentExecutableDir = path.dirname(app.getPath('exe'));
//
// export const getIsPortableSync = lazy((): boolean => {
//     const isPortable = existsSync(path.join(currentExecutableDir, 'portable'));
//     return isPortable;
// });
//
// export const getRootDir = lazy((): string => {
//     const isPortable = getIsPortableSync();
//     const rootDir = isPortable ? currentExecutableDir : app.getPath('userData');
//     return rootDir;
// });
//
// export const getLogsFolder = lazy((): string => {
//     return path.join(getRootDir(), 'logs');
// });
//
// export const getBackendStorageFolder = lazy((): string => {
//     return path.join(getRootDir(), 'backend-storage');
// });
//
// export const installDir = getIsPortableSync()
//     ? path.dirname(app.getPath('exe'))
//     : path.join(path.dirname(app.getPath('exe')), '..');