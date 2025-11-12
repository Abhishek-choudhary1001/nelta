import Calculator from './components/calculator';

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">
            Design Calculator
          </h1>
          <p className="text-gray-600 text-lg">
            A simple, modern calculator built with Next.js and Tailwind CSS
          </p>
        </div>
        <Calculator />
      </div>
    </main>
  );
}