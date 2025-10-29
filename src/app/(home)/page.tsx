import { ProjectForm } from "@/modules/home/ui/components/project-form"
import { ProjectsList } from "@/modules/home/ui/components/projects-list"
import Image from "next/image"


const page = () => {
  return (
    <div className='flex flex-col max-w-5xl mx-auto w-full'>
      <section className="space-y-6 py-[16vh] 2xl:py-48">
        <div className="flex flex-col items-center">
          <Image
          src="/logo.svg"
          alt="NELTA"
          width={50}
          height={50}
          className="hidden md:block"
          />
        </div>
        <h1 className="text-lg md:text-xl text-muted-foreground text-center">Build something with NELTA</h1>
        <div className="max-w-3xl mx-auto w-full">
          <ProjectForm/>
        </div>
      </section>
      <ProjectsList/>
    </div>
  ) 
}

export default page
