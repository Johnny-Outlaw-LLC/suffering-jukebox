// Create an isolated Record Keeper Xcode project from the tracked CarPlay source.
import {execFileSync} from 'node:child_process';
import {mkdir,copyFile,readFile,writeFile,access} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const native=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const repo=resolve(native,'..');
const destination=resolve(native,'recordkeeper/ios');
try {await access(destination);console.log('Using the existing Record Keeper Xcode project; local Mac edits are preserved.');process.exit(0);}
catch(error){if(error.code!=='ENOENT')throw error;}
const files=execFileSync('git',['ls-files','native/ios'],{cwd:repo,encoding:'utf8'}).trim().split('\n');
for(const path of files) {
    const target=resolve(destination,path.slice('native/ios/'.length));await mkdir(dirname(target),{recursive:true});
    if(/\.(swift|plist|pbxproj|storyboard|entitlements)$/.test(path)||path.endsWith('Podfile')) {
        let value=await readFile(resolve(repo,path),'utf8');
        value=value.replaceAll('com.johnnyoutlaw.sufferingjukebox','com.johnnyoutlaw.recordkeeper')
            .replaceAll('com.johnnyoutlaw.listeningparty','com.johnnyoutlaw.recordkeeper')
            .replaceAll('https://listeningparty.stream','https://recordkeeper.stream')
            .replaceAll('Listening Party','Record Keeper').replaceAll('sj.carplay.key','rk.carplay.key');
        if(path.endsWith('Podfile'))value=value.replaceAll('../../node_modules/','../../../node_modules/');
        if(path.endsWith('project.pbxproj'))value=value.replace(/CURRENT_PROJECT_VERSION = \d+;/g,'CURRENT_PROJECT_VERSION = 1;').replace(/MARKETING_VERSION = [^;]+;/g,'MARKETING_VERSION = 1.0;');
        await writeFile(target,value);
    } else await copyFile(resolve(repo,path),target);
}
await copyFile(resolve(native,'recordkeeper/store/assets/app-icon-1024.png'),resolve(destination,'App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
for(const name of ['splash-2732x2732.png','splash-2732x2732-1.png','splash-2732x2732-2.png'])
    await copyFile(resolve(native,'recordkeeper/store/assets/splash-2732.png'),resolve(destination,'App/App/Assets.xcassets/Splash.imageset',name));
console.log('Record Keeper Xcode project prepared at '+destination);
