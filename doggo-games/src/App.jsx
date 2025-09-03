import "./App.css";
import DoggoGames from "./DoggoGames";

const initialPhotos = Array.from({ length: 16 }, (_, i) => `/maci${i + 1}.jpg`);

function App() {
  return <DoggoGames initialPhotos={initialPhotos} />;
}

export default App;
