/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { NewAppScreen } from '@react-native/new-app-screen';
import { StatusBar, StyleSheet, useColorScheme, View, Button, Text } from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {pickFiles, pickFolder, readFile, writeFile} from './module/utils/file';
import { useState } from 'react';
import {UnpackedEntry, unpackPak, PakHeader} from './module/unpak/tapsonicPak'


function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const safeAreaInsets = useSafeAreaInsets();
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [File, setFile] = useState<File | null>(null);
  const [selectedKeyPaths, setSelectedKeyPaths] = useState<string[]>([]);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [depressPath, setDepressPath] = useState<string | null>(null);
  const [info, setInfo] = useState<{header: PakHeader;
    entries: UnpackedEntry[];} | null>(null);

  const handlePickSingleFile = async () => {
    try {
      const files = await pickFiles(false); // 단일 파일
      if (files.length === 0) return; // 사용자가 취소함
      setSelectedPaths(files);
      const pakFile = await readFile(files[0], 'File')
      setFile(pakFile);
      if(!keyFile) {
        console.error('key 파일이 선택되지 않았습니다.');
        return;
      }
      setInfo(await unpackPak(pakFile, keyFile));
      setDepressPath(null); 
    } catch (e) {
      console.error('파일 선택 실패:', e);
    }
  };
    const handlePickKeyFile = async () => {
    try {
      const files = await pickFiles(false); // 단일 파일
      if (files.length === 0) return; // 사용자가 취소함
      setSelectedKeyPaths(files);
      setKeyFile(await readFile(files[0], 'File'));
    } catch (e) {
      console.error('파일 선택 실패:', e);
    }
  };
  const handlePickDepressPath = async () => {
    try {
      const path = await pickFolder(); // 단일 파일
      setDepressPath(path);
      if(!info) {
        console.error('pak 파일이 선택되지 않았습니다.');
        return;
      }
      info.entries.forEach(async (entry) => {
        const outputPath = `${path}/${entry.info.name}`;
        await writeFile(outputPath, entry.file);
      });
    } catch (e) {
      console.error('파일 선택 실패:', e);
    }
  };



  return (
    <View style={styles.container}>
      <View style={{ padding: 24, gap: 12 }}>
      <Button title="key 파일 1개 선택" onPress={handlePickKeyFile} />
      {selectedKeyPaths.map((path) => (
        <Text key={path}>{path}</Text>
      ))}
      <Button title="pak 파일 1개 선택" onPress={handlePickSingleFile} />
      {selectedPaths.map((path) => (
        <Text key={path}>{path}</Text>
      ))}
      {info && (
        <View>
          <Text>Header: {JSON.stringify(info.header)}</Text>
          <Text>Entries: {info.entries.length}</Text>
          <Button title="압축 풀 폴더 선택" onPress={handlePickDepressPath} />
          {depressPath && (
            <Text>{depressPath}</Text>
          )}
        </View>
      )}
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
